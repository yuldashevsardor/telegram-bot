import "reflect-metadata";
import { expect } from "chai";
import { BotError, HttpError } from "grammy";
import type { Context } from "grammy";
import { Database } from "app/platform/database/database";
import { MS_PER_DAY, MS_PER_SECOND } from "app/shared/time";
import { sleep } from "app/shared/utils";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { InboxFailureClassifier } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type {
    ClaimedInboxUpdate,
    InboxAttempt,
    InboxAttemptError,
    InboxCleanupSettings,
    InboxUpdateInput,
    InboxWorker,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxResultTimeout } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import { testDatabaseSettings } from "test/database.helper";
import { telegramError } from "test/telegram/telegram-bot-api-failure-classifier.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

const USER = 5_000_000_001;
const OTHER_USER = 5_000_000_002;
const CHAT = 5_000_000_001;
const TOKEN = "123456789:secret";
const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 60_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new OutboxRetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 600_000, multiplier: MULTIPLIER }, () => 0);
const LEASE_DURATION_MS = 600_000;
const CLEANUP: InboxCleanupSettings = { doneRetentionMs: MS_PER_DAY, skippedRetentionMs: MS_PER_DAY, batchSize: 10 };
// A lease that passes before the spec recovers it, after a sleep of twice as long.
const SHORT_LEASE_MS = 10;
// How far the delay read back may fall short of the one written: the time between the two statements.
const ELAPSED_TOLERANCE_MS = 1_000;
const WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };

// What the attempt of an expired lease ends with. Spelled out rather than imported: the handler
// keeps it private, and the attempts it lands in are read by people.
const LEASE_EXPIRED: InboxAttemptError = {
    name: "InboxLeaseExpired",
    message: "The lease of the group passed before its update was completed: the node that claimed it is presumed dead.",
    kind: InboxFailureKind.Transient,
};

// The handler runs over the real store: the outcome of each error class is pinned in the rows it
// leaves, and the store spec pins how each outcome is written.
describe("InboxFailureHandler", function () {
    let database: Database;
    let logger: RecordingLogger;
    let store: InboxStore;
    let handler: InboxFailureHandler;

    before(async function () {
        database = new Database(await testDatabaseSettings(), false);
    });

    beforeEach(async function () {
        logger = new RecordingLogger();
        useStore(new InboxStore(database, logger, LEASE_DURATION_MS, CLEANUP));
        await database.sql`TRUNCATE telegram_inbox, telegram_inbox_groups`;
    });

    after(async function () {
        // A failed before does not get to assign the client, and a failure in after would hide its cause.
        await database?.close();
    });

    function useStore(inboxStore: InboxStore): void {
        store = inboxStore;
        handler = new InboxFailureHandler(
            store,
            new InboxFailureClassifier(new TelegramBotApiFailureClassifier()),
            RETRY_DELAY,
            new OutboxErrorSerializer(TOKEN),
            MAX_ATTEMPTS,
        );
    }

    describe("a transient failure", function () {
        it("returns the update to pending and holds its group for the retry delay of its attempt", async function () {
            await store.pushBatch([input(10), input(11)]);

            await handler.handle(await claimOne(), new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET")));

            expect(await statuses()).to.deep.equal([InboxStatus.Pending, InboxStatus.Pending]);
            expect(await groupState(USER)).to.equal(InboxGroupState.Ready);
            expect(await waitMs(USER)).to.be.within(FIRST_DELAY_MS / 2 - ELAPSED_TOLERANCE_MS, FIRST_DELAY_MS / 2);
            expect(await store.claim(10, WORKER)).to.deep.equal([]);
            expect((await attempts(10)).map(({ error }) => error?.["kind"])).to.deep.equal([InboxFailureKind.Transient]);
        });

        it("lengthens the retry delay with every counted attempt", async function () {
            await store.push(input(10));

            await handler.handle(await claimOne(), lostConnection());
            await dueNow(USER);
            await handler.handle(await claimOne(), lostConnection());

            expect(await waitMs(USER)).to.be.within(FIRST_DELAY_MS - ELAPSED_TOLERANCE_MS, FIRST_DELAY_MS);
        });

        it("fails the update and blocks its group on the last attempt", async function () {
            await store.pushBatch([input(10), input(11)]);

            for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
                await handler.handle(await claimOne(), lostConnection());
                await dueNow(USER);
            }

            await handler.handle(await claimOne(), lostConnection());

            expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending]);
            expect(await groupState(USER)).to.equal(InboxGroupState.Blocked);
            expect(await attempts(10)).to.have.lengthOf(MAX_ATTEMPTS);
            expect(logger.errors.map(({ message }) => message)).to.deep.equal(["Inbox group is blocked by a failed update."]);
        });
    });

    describe("an undeliverable failure", function () {
        it("fails the update and goes on to the next update of its group", async function () {
            await store.pushBatch([input(10), input(11)]);

            await handler.handle(await claimOne(), telegramError(403, "Forbidden: bot was blocked by the user"));

            expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending]);
            expect((await claimOne()).updateId).to.equal(11);
            expect((await attempts(10)).map(({ error }) => error?.["kind"])).to.deep.equal([InboxFailureKind.Undeliverable]);
            expect(logger.errors).to.deep.equal([]);
        });
    });

    describe("an unexpected failure", function () {
        it("fails the update and blocks its group on a timeout waiting for the outbox", async function () {
            await store.pushBatch([input(10), input(11)]);

            await handler.handle(await claimOne(), OutboxResultTimeout.of(1, 60_000));

            expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending]);
            expect(await groupState(USER)).to.equal(InboxGroupState.Blocked);
            expect((await attempts(10)).map(({ error }) => error?.["kind"])).to.deep.equal([InboxFailureKind.Unexpected]);
            expect(logger.errors.map(({ payload }) => payload?.["updateId"])).to.deep.equal([10]);
        });

        it("blocks the group on the first attempt, with no retry", async function () {
            await store.push(input(10));

            await handler.handle(await claimOne(), new TypeError("Cannot read properties of undefined"));

            expect(await statuses()).to.deep.equal([InboxStatus.Failed]);
            expect(await attempts(10)).to.have.lengthOf(1);
        });
    });

    describe("a BotError", function () {
        // Bot.handleUpdate() wraps the error of the middleware with the context, the Api and its token
        // included.
        it("is classified and written as the handler's own error, without the context", async function () {
            await store.pushBatch([input(10), input(11)]);
            const context = { api: { token: TOKEN }, update: input(10).update } as unknown as Context;

            await handler.handle(await claimOne(), new BotError(telegramError(403, "Forbidden: bot was blocked by the user"), context));

            const [attempt] = await attempts(10);

            expect(await groupState(USER)).to.equal(InboxGroupState.Ready);
            expect(attempt?.error).to.deep.include({ name: "GrammyError", error_code: 403, kind: InboxFailureKind.Undeliverable });
            expect(attempt?.error).not.to.have.property("ctx");
            expect(JSON.stringify(attempt?.error)).not.to.include(TOKEN);
        });
    });

    describe("lease recovery", function () {
        beforeEach(function () {
            useStore(new InboxStore(database, logger, SHORT_LEASE_MS, CLEANUP));
        });

        it("redelivers the update of an expired lease, with the recovery counted as an attempt", async function () {
            await store.push(input(10));
            const claimed = await claimOne();
            await sleep(SHORT_LEASE_MS * 2);

            await handler.recoverExpiredLeases();

            const [attempt] = await attempts(10);

            expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
            expect(await waitMs(USER)).to.be.within(FIRST_DELAY_MS / 2 - ELAPSED_TOLERANCE_MS, FIRST_DELAY_MS / 2);
            expect(attempt).to.deep.include({ started_at: claimed.startedAt, worker: null, error: LEASE_EXPIRED });

            await dueNow(USER);

            expect(await claimOne()).to.deep.include({ updateId: 10, earlierAttempts: 1 });
        });

        it("leaves alone a lease that has not passed", async function () {
            await store.push(input(10, USER));
            await claimOne();
            const longLeasing = new InboxStore(database, logger, LEASE_DURATION_MS, CLEANUP);
            await longLeasing.push(input(20, OTHER_USER));
            await longLeasing.claim(10, WORKER);
            await sleep(SHORT_LEASE_MS * 2);

            await handler.recoverExpiredLeases();

            expect(await statuses()).to.deep.equal([InboxStatus.Pending, InboxStatus.Processing]);
            expect(await groupState(OTHER_USER)).to.equal(InboxGroupState.Processing);
        });

        it("fails the update and blocks its group when the expired lease held its last attempt", async function () {
            await store.push(input(10));

            for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
                await store.retry(await claimOne(), { kind: InboxFailureKind.Transient, message: "lost" }, 0);
            }

            await claimOne();
            await sleep(SHORT_LEASE_MS * 2);

            await handler.recoverExpiredLeases();

            expect(await statuses()).to.deep.equal([InboxStatus.Failed]);
            expect(await groupState(USER)).to.equal(InboxGroupState.Blocked);
        });

        it("changes nothing on a completion of the node presumed dead after the recovery", async function () {
            await store.push(input(10));
            const claimed = await claimOne();
            await sleep(SHORT_LEASE_MS * 2);

            await handler.recoverExpiredLeases();
            await store.markAsDone(claimed);
            await handler.handle(claimed, OutboxResultTimeout.of(1, 60_000));

            expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
            expect(await groupState(USER)).to.equal(InboxGroupState.Ready);
            expect(await attempts(10)).to.have.lengthOf(1);
            expect(logger.warnings.map(({ message }) => message)).to.deep.equal([
                "Inbox completion with a stale lock token changed nothing.",
                "Inbox completion with a stale lock token changed nothing.",
            ]);
            expect(logger.errors).to.deep.equal([]);
        });
    });

    // The only update a claim gives out.
    async function claimOne(): Promise<ClaimedInboxUpdate> {
        const claimed = await store.claim(10, WORKER);

        expect(claimed).to.have.lengthOf(1);

        return claimed[0] as ClaimedInboxUpdate;
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_inbox ORDER BY update_id`;

        return rows.map((row) => row.status);
    }

    async function groupState(userId: number): Promise<string | undefined> {
        const [row] = await database.sql<{ state: string }[]>`SELECT state FROM telegram_inbox_groups WHERE user_id = ${userId}`;

        return row?.state;
    }

    // How long the group of the user waits before its next claim.
    async function waitMs(userId: number): Promise<number | undefined> {
        const [row] = await database.sql<{ wait_ms: number }[]>`
            SELECT extract(epoch FROM next_attempt_at - now())::double precision * ${MS_PER_SECOND} AS wait_ms
            FROM telegram_inbox_groups
            WHERE user_id = ${userId}
        `;

        return row?.wait_ms;
    }

    // Cuts the retry delay of the group short, so the next claim takes its head.
    async function dueNow(userId: number): Promise<void> {
        await database.sql`UPDATE telegram_inbox_groups SET next_attempt_at = now() WHERE user_id = ${userId}`;
    }

    async function attempts(updateId: number): Promise<InboxAttempt[]> {
        const [row] = await database.sql<{ attempts: InboxAttempt[] }[]>`SELECT attempts FROM telegram_inbox WHERE update_id = ${updateId}`;

        return row?.attempts ?? [];
    }
});

// A message update of the user in the chat.
function input(updateId: number, userId = USER): InboxUpdateInput {
    return messageInput(updateId, userId, CHAT);
}

// The error postgres.js gives a query whose connection closed under it.
function lostConnection(): Error {
    return Object.assign(new Error("write CONNECTION_CLOSED pgsql:5432"), { code: "CONNECTION_CLOSED" });
}
