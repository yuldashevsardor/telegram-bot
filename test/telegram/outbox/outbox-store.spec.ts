import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { TransactionSql } from "postgres";
import { Database } from "app/platform/database/database";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type {
    ExpiredOutboxLease,
    OutboxAttempt,
    OutboxAttemptError,
    OutboxCleanupSettings,
    OutboxLease,
    OutboxMessageInput,
    OutboxPullResult,
    OutboxWorker,
    PulledOutboxMessage,
} from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import {
    BotLimitsRowMissing,
    InvalidPauseDuration,
    InvalidPullLimit,
    OutboxMessageNotLeased,
} from "app/telegram/outbox/store/outbox-store.errors";
import { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { MS_PER_SECOND } from "app/shared/time";
import { sleep } from "app/shared/utils";
import { testDatabaseSettings, waitForLockWaiters } from "test/database.helper";
import { listenTo, waitUntil } from "test/telegram/outbox/outbox-store.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const CHAT = 5_000_000_001;
const OTHER_CHAT = -1_001_234_567_890;
// A chat left ready while the others are leased.
const READY_CHAT = 5_000_000_002;
const RESPONSE = { message_id: 1 };
// Longer than any wait of a passing run, shorter than SPEC_TIMEOUT_MS: a hung wait fails with its
// own message and stops before after() closes the clients.
const WAIT_DEADLINE_MS = 5_000;
// The default timeout of mocha, 2 s, is shorter than the deadline and would fail a hung wait first.
const SPEC_TIMEOUT_MS = 10_000;
// The limits of the specs that are not about the limits: a cooldown of a nanosecond, below the
// microsecond of a timestamp, and a common limit no pull reaches.
const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };
const LEASE_DURATION_MS = 600_000;
const HOUR_MS = 60 * 60 * MS_PER_SECOND;
const CLEANUP: OutboxCleanupSettings = { doneRetentionMs: HOUR_MS, skippedRetentionMs: 2 * HOUR_MS, batchSize: 10 };
const WORKER: OutboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
const TRANSIENT: OutboxAttemptError = { kind: TelegramBotApiFailureKind.Transient, message: "Network request failed" };
const FLOOD: OutboxAttemptError = { kind: TelegramBotApiFailureKind.Flood, message: "Too Many Requests: retry after 5" };
const UNDELIVERABLE: OutboxAttemptError = {
    kind: TelegramBotApiFailureKind.Undeliverable,
    message: "Forbidden: bot was blocked by the user",
};
const UNEXPECTED: OutboxAttemptError = { kind: TelegramBotApiFailureKind.Unexpected, message: "Bad Request: message text is empty" };
// How much of a long pause, interval or delay the calls between its start and the pull may use up.
const ELAPSED_TOLERANCE_MS = 1_000;
const EXPIRED_LEASE_ERROR: OutboxAttemptError = { kind: TelegramBotApiFailureKind.Transient, message: "The lease of the chat passed" };
// A lease that passes while the spec sleeps twice as long.
const SHORT_LEASE_MS = 10;
// A token no pull gave out.
const OTHER_TOKEN = "00000000-0000-4000-8000-000000000000";
// Longer than any spec runs: a chat retried with it is not pulled again by the spec.
const LONG_RETRY_DELAY_MS = 60_000;
// The placeholder of a pull a spec starts inside a transaction.
const NOTHING_PULLED: OutboxPullResult = { messages: [], nextPullInMs: null };

type ChatRow = { state: string };
describe("OutboxStore", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let database: Database;
    // A second postgres() client: a puller on another node, or a transaction held open.
    let other: Database;
    // The client of waitForLockWaiters(). Store calls waiting for a lock hold connections of
    // database, and a poll through the same pool would queue behind them at a small
    // DATABASE_CONNECTION_LIMIT, hanging past the deadline instead of failing on it.
    let observer: Database;
    let logger: RecordingLogger;
    let store: OutboxStore;
    let settings: DatabaseSettings;

    before(async function () {
        settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
        observer = new Database(settings, false);
    });

    beforeEach(async function () {
        logger = new RecordingLogger();
        store = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP);
        await database.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
        // The common limit has saved up its full number of slots, and there is no pause. The table
        // holds one row.
        await database.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
        `;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await database?.close();
        await other?.close();
        await observer?.close();
    });

    it("keeps the single row of the bot limits", async function () {
        const rows = await database.sql`SELECT id, paused_until FROM telegram_bot_limits`;

        expect([...rows]).to.deep.equal([{ id: 1, paused_until: null }]);
    });

    it("gives out the messages of a chat in id order", async function () {
        const ids = [
            await store.push(message(CHAT, "first")),
            ...(await store.pushBatch([message(CHAT, "second"), message(CHAT, "third")])),
        ];

        expect(await drain(store)).to.deep.equal(ids);
        expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Idle });
    });

    it("returns the ids of a batch in the order of the input across chats", async function () {
        const ids = await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b"), message(CHAT, "c")]);
        const rows = await database.sql<{ id: string; text: string }[]>`
            SELECT id, payload ->> 'text' AS text
            FROM telegram_outbox
            ORDER BY id
        `;

        expect(rows.map((row) => [Number(row.id), row.text])).to.deep.equal([
            [ids[0], "a"],
            [ids[1], "b"],
            [ids[2], "c"],
        ]);
    });

    it("keeps the method, the payload and the priority of a pulled message", async function () {
        const id = await store.push({
            chatId: OTHER_CHAT,
            method: "sendPhoto",
            payload: { photo: "file-id", caption: null },
            priority: 3,
        });

        const [pulled] = (await store.pull(10, WORKER)).messages;

        expect(pulled).to.deep.include({
            id,
            chatId: OTHER_CHAT,
            method: "sendPhoto",
            payload: { photo: "file-id", caption: null },
            priority: 3,
        });
    });

    // 2 ** 53 is the first integer above Number.MAX_SAFE_INTEGER.
    for (const limit of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        it(`refuses a pull of ${limit} messages and pulls nothing`, async function () {
            await store.push(message(CHAT, "text"));

            const error = await store.pull(limit, WORKER).then(
                () => expect.fail("pull() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.be.instanceOf(InvalidPullLimit);
            expect((error as InvalidPullLimit).payload).to.deep.equal({ limit });
            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
        });
    }

    it("takes a limit and a common number beyond a 32-bit integer", async function () {
        const aboveInt32 = 2 ** 31;
        const bigLimitStore = new OutboxStore(
            database,
            logger,
            { ...NO_LIMITS, common: { number: aboveInt32, interval: 1 } },
            LEASE_DURATION_MS,
            CLEANUP,
        );
        // Two chats, so a budget cut down to one message would show.
        const ids = await bigLimitStore.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

        expect((await bigLimitStore.pull(aboveInt32, WORKER)).messages.map((pulled) => pulled.id)).to.deep.equal(ids);
    });

    it("never keeps two messages of a chat in processing", async function () {
        await store.pushBatch([message(CHAT, "first"), message(CHAT, "second"), message(CHAT, "third")]);

        expect((await store.pull(10, WORKER)).messages).to.have.lengthOf(1);
        expect((await store.pull(10, WORKER)).messages).to.deep.equal([]);
        expect(await statuses()).to.deep.equal([OutboxStatus.Processing, OutboxStatus.Pending, OutboxStatus.Pending]);
        expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Processing });
    });

    it("serves the chats in turn, not one chat drained first", async function () {
        const first = await store.pushBatch([message(CHAT, "1"), message(CHAT, "2"), message(CHAT, "3")]);
        const second = await store.pushBatch([message(OTHER_CHAT, "1"), message(OTHER_CHAT, "2"), message(OTHER_CHAT, "3")]);

        expect(await drain(store)).to.deep.equal([first[0], second[0], first[1], second[1], first[2], second[2]]);
    });

    it("takes one head from each of several ready chats in one pull", async function () {
        const [a] = await store.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
        const [b] = await store.pushBatch([message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

        expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([a, b]);
    });

    it("pulls no more chats than the limit", async function () {
        await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

        expect((await store.pull(1, WORKER)).messages).to.have.lengthOf(1);
    });

    // The priority of a chat is the priority of its head: a later, more urgent message of the same
    // chat does not move the chat ahead.
    it("pulls the chats by the priority of their head, not of their latest message", async function () {
        await store.pushBatch([message(CHAT, "head", 300), message(CHAT, "urgent", 100)]);
        const other = await store.push(message(OTHER_CHAT, "middle", 200));

        expect((await store.pull(1, WORKER)).messages.map(({ id }) => id)).to.deep.equal([other]);
    });

    it("stores the response and the end of a done message, and says the message is done", async function () {
        const id = await store.push(message(CHAT, "text"));

        expect(await store.markAsDone(await pullOne(), RESPONSE)).to.equal(true);

        const [row] = await database.sql<{ status: string; response: unknown; finished: boolean }[]>`
            SELECT status, response, finished_at IS NOT NULL AS finished
            FROM telegram_outbox
            WHERE id = ${id}
        `;

        expect(row).to.deep.equal({ status: OutboxStatus.Done, response: RESPONSE, finished: true });
    });

    it("refuses to mark done a message that does not exist", async function () {
        await expectNotLeased(lease(404, OTHER_TOKEN));
    });

    it("refuses a lease of its chat that names another message of the chat and changes nothing", async function () {
        const [, second] = await store.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);
        const pulled = await pullOne();

        await expectNotLeased(lease(second as number, pulled.lockToken));
        expect(await statuses()).to.deep.equal([OutboxStatus.Processing, OutboxStatus.Pending]);
        expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Processing });
    });

    it("takes a chat with a higher-priority head first", async function () {
        await store.push(message(CHAT, "later", 2));
        const urgent = await store.push(message(OTHER_CHAT, "urgent", 0));

        expect((await store.pull(1, WORKER)).messages.map(({ id }) => id)).to.deep.equal([urgent]);
    });

    it("returns the pulled messages by priority, not by id", async function () {
        const later = await store.push(message(CHAT, "later", 2));
        const urgent = await store.push(message(OTHER_CHAT, "urgent", 0));

        expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([urgent, later]);
    });

    // The chats of one pull get the same next_attempt_at: with NO_LIMITS the cooldown of a private
    // chat and of a group is a nanosecond, so both round to the time of the statement. Without the
    // chat_id key their next turn follows the order PostgreSQL meets the tied rows in, which tends to
    // be the order of completion: the spec completes them in both orders, and one of them fails then.
    for (const completedFirst of [CHAT, OTHER_CHAT]) {
        it(`takes the chats served in one pull by chat_id in the next turn, chat ${completedFirst} completed first`, async function () {
            await store.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
            await store.pushBatch([message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

            const pulled = (await store.pull(10, WORKER)).messages;
            const first = pulled.filter(({ chatId }) => chatId === completedFirst);
            const rest = pulled.filter(({ chatId }) => chatId !== completedFirst);

            for (const pulledMessage of [...first, ...rest]) {
                await store.markAsDone(pulledMessage, RESPONSE);
            }

            expect((await store.pull(1, WORKER)).messages.map(({ chatId }) => chatId)).to.deep.equal([OTHER_CHAT]);
        });
    }

    // An id taken before the chat lock would let two overlapping pushes of one chat commit in the
    // order opposite to their ids, and the later id would be sent first. The push of another chat
    // stands in for the one that commits first.
    it("takes the ids of a push only once its chat is locked", async function () {
        await store.push(message(CHAT, "first"));

        let waiting: Promise<number> = Promise.resolve(0);
        let passing = 0;

        await other.sql.begin(async (sql) => {
            await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

            waiting = store.push(message(CHAT, "waiting"));

            await waitForLockWaiters(observer, 1);

            passing = await store.push(message(OTHER_CHAT, "passing"));
        });

        expect(await waiting).to.be.greaterThan(passing);
    });

    // A pull inside a transaction of the other client keeps what it locked until the commit, as a
    // pull on another node does for the length of its statement.
    it("waits for another pull holding the bot row and takes what that pull left", async function () {
        const [, leftMessageId] = await store.pushBatch([message(OTHER_CHAT, "held"), message(CHAT, "left")]);

        let waiting: Promise<OutboxPullResult> = Promise.resolve(NOTHING_PULLED);

        await other.sql.begin(async (sql) => {
            expect((await storeOn(sql).pull(1, WORKER)).messages).to.have.lengthOf(1);

            waiting = store.pull(10, WORKER);

            await waitForLockWaiters(observer, 1);
        });

        expect((await waiting).messages.map(({ id }) => id)).to.deep.equal([leftMessageId]);
    });

    it("leaves the bot row to other pulls when it has no chat to pull", async function () {
        await other.sql.begin(async (sql) => {
            expect((await storeOn(sql).pull(10, WORKER)).messages).to.deep.equal([]);

            const id = await store.push(message(CHAT, "text"));

            expect((await store.pull(10, WORKER)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });
    });

    it("skips a chat another puller holds and takes the next one", async function () {
        await store.push(message(CHAT, "held"));
        const free = await store.push(message(OTHER_CHAT, "free"));

        await other.sql.begin(async (sql) => {
            await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

            expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([free]);
        });
    });

    it("never gives one message or two heads of a chat to two pullers on separate clients", async function () {
        this.timeout(20_000);

        const chats = [CHAT, OTHER_CHAT, 1, 2, 3, 4];
        const perChat = 8;
        const ids = await store.pushBatch(
            Array.from({ length: perChat }, (_, index) => chats.map((chatId) => message(chatId, String(index)))).flat(),
        );
        const pulls: number[] = [];
        const pullsByChat = new Map<number, number[]>();
        const inFlight = new Set<number>();

        const deadline = Date.now() + WAIT_DEADLINE_MS;
        let hasFailed = false;

        // A chat leaves inFlight before markAsDone commits: the chat can be pulled only after the
        // commit, so an overlap seen here is a real one.
        const pull = async (client: OutboxStore): Promise<void> => {
            while (!hasFailed && pulls.length < ids.length) {
                if (Date.now() > deadline) {
                    expect.fail(`${pulls.length} of ${ids.length} messages pulled by the deadline`);
                }

                const batch = (await client.pull(2, WORKER)).messages;

                if (batch.length === 0) {
                    await sleep(1);
                    continue;
                }

                for (const pulled of batch) {
                    expect(inFlight.has(pulled.chatId), `chat ${pulled.chatId} is pulled twice`).to.equal(false);
                    inFlight.add(pulled.chatId);
                    pulls.push(pulled.id);
                    pullsByChat.set(pulled.chatId, [...(pullsByChat.get(pulled.chatId) ?? []), pulled.id]);
                }

                for (const pulled of batch) {
                    await sleep(Math.random() * 3);
                    inFlight.delete(pulled.chatId);
                    await client.markAsDone(pulled, RESPONSE);
                }
            }
        };

        // A failed puller stops the other one, which would otherwise keep going after the test.
        const puller = (client: OutboxStore): Promise<void> =>
            pull(client).catch((error: unknown) => {
                hasFailed = true;
                throw error;
            });

        await Promise.all([puller(store), puller(new OutboxStore(other, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP))]);

        expect([...pulls].sort((a, b) => a - b)).to.deep.equal(ids);

        for (const [chatId, chatPulls] of pullsByChat) {
            expect(chatPulls, `chat ${chatId}`).to.deep.equal([...chatPulls].sort((a, b) => a - b));
        }
    });

    describe("limits", function () {
        // A private chat gets a message every 2 s, a group every 30 s.
        const PRIVATE_COOLDOWN_MS = 2_000;
        const GROUP_COOLDOWN_MS = 30_000;
        const CHAT_LIMITS: TelegramLimits = {
            common: NO_LIMIT,
            private: { number: 1, interval: PRIVATE_COOLDOWN_MS },
            group: { number: 2, interval: 2 * GROUP_COOLDOWN_MS },
        };
        // Three messages a 3 s interval, a second apart.
        const COMMON_COOLDOWN_MS = 1_000;
        const COMMON_INTERVAL_MS = 3 * COMMON_COOLDOWN_MS;
        const COMMON_NUMBER = 3;
        const COMMON_LIMITS: TelegramLimits = { ...NO_LIMITS, common: { number: COMMON_NUMBER, interval: COMMON_INTERVAL_MS } };
        // More ready chats than the common limit gives out at once.
        const MANY_CHAT_IDS = Array.from({ length: COMMON_NUMBER + 2 }, (_, index) => index + 1);
        const PAUSE_MS = 60_000;
        // A pause shorter than the pause asked for, which must not shorten it.
        const SHORTER_PAUSE_MS = PAUSE_MS / 2;
        // A pause that is over by the time the spec sleeps SHORT_PAUSE_MS twice.
        const SHORT_PAUSE_MS = 5;
        // The cooldown of the spec on the pulls queued behind a slow one: each pull of it starts more
        // than a cooldown after the one before, and its statement takes far less than a cooldown.
        const QUEUED_COOLDOWN_MS = 200;
        // How long after the push the chat of the spec on a wait for the bot row comes due.
        const DUE_LATER_MS = 200;
        // What a spec sleeps past a cooldown or a due time, so that it has passed for the database.
        const TIMING_MARGIN_MS = 50;

        it("gives a chat no message before its interval has passed", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS, CLEANUP);
            const [, second] = await limited.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);
            const [first] = (await limited.pull(10, WORKER)).messages;

            await limited.markAsDone(first as PulledOutboxMessage, RESPONSE);

            const early = await limited.pull(10, WORKER);

            expect(early.messages).to.deep.equal([]);
            expect(early.nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);

            await database.sql`UPDATE telegram_outbox_chats SET next_attempt_at = now()`;

            expect((await limited.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([second]);
        });

        it("keeps the chat limit of a message retried with a shorter delay", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.push(message(CHAT, "text"));
            const [pulled] = (await limited.pull(10, WORKER)).messages;

            await limited.retry(pulled as PulledOutboxMessage, TRANSIENT, 0);

            const early = await limited.pull(10, WORKER);

            expect(early.messages).to.deep.equal([]);
            expect(early.nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);
        });

        it("moves a pulled chat by the interval of a private chat or a group, by the sign of its id", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch([message(CHAT, "private"), message(OTHER_CHAT, "group")]);
            await limited.pull(10, WORKER);

            // Both columns are the time of the pull.
            const rows = await database.sql<{ chat_id: string; moved_ms: number }[]>`
                SELECT chat_id, extract(epoch FROM next_attempt_at - updated_at)::double precision * ${MS_PER_SECOND} AS moved_ms
                FROM telegram_outbox_chats
                ORDER BY chat_id
            `;

            expect(rows.map((row) => [Number(row.chat_id), row.moved_ms])).to.deep.equal([
                [OTHER_CHAT, GROUP_COOLDOWN_MS],
                [CHAT, PRIVATE_COOLDOWN_MS],
            ]);
        });

        it("gives a batch no more messages than the common limit allows now", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));

            expect((await limited.pull(10, WORKER)).messages).to.have.lengthOf(COMMON_NUMBER);

            const spent = await limited.pull(10, WORKER);

            expect(spent.messages).to.deep.equal([]);
            expect(spent.nextPullInMs).to.be.within(COMMON_INTERVAL_MS - COMMON_COOLDOWN_MS, COMMON_INTERVAL_MS);
        });

        // Slots saved up and spent at once must not come due again inside the same interval: after a
        // burst of the whole limit a slot a cooldown later would put number + 1 messages in it.
        it("holds the next message back a cooldown per message of the batch, from the pull", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            await limited.pull(10, WORKER);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_INTERVAL_MS);

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now()`;
            await limited.pull(10, WORKER);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_COOLDOWN_MS);
        });

        it("gives out only the slots of the common limit that have come due", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            // Two slots have come due: at next_send_at and a cooldown later; the third is half a
            // cooldown away.
            const twoSlotsAgoMs = COMMON_COOLDOWN_MS + COMMON_COOLDOWN_MS / 2;

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now() - ${twoSlotsAgoMs}::double precision * interval '1 millisecond'`;

            expect((await limited.pull(10, WORKER)).messages).to.have.lengthOf(2);
        });

        it("stops the pull on every client while the pause lasts", async function () {
            await store.push(message(CHAT, "text"));
            await store.pause(PAUSE_MS);

            const paused = await new OutboxStore(other, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP).pull(10, WORKER);

            expect(paused.messages).to.deep.equal([]);
            expect(paused.nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
            expect((await store.pull(10, WORKER)).messages).to.deep.equal([]);
        });

        // The pull that waited reads the rest of the statement from the snapshot taken before the
        // wait, where the bot row is still due: an answer from that snapshot would be zero.
        it("answers a pull that waited for another pull by the next_send_at that pull left", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch([message(OTHER_CHAT, "held"), message(CHAT, "left")]);

            let waiting: Promise<OutboxPullResult> = Promise.resolve(NOTHING_PULLED);

            await other.sql.begin(async (sql) => {
                expect((await storeOn(sql, COMMON_LIMITS).pull(1, WORKER)).messages).to.have.lengthOf(1);

                waiting = limited.pull(1, WORKER);

                await waitForLockWaiters(observer, 1);
            });

            const answer = await waiting;

            expect(answer.messages).to.deep.equal([]);
            expect(answer.nextPullInMs).to.be.within(1, COMMON_COOLDOWN_MS);
        });

        it("answers a pull that waited for a pause by the end of that pause", async function () {
            await store.push(message(CHAT, "text"));

            let waiting: Promise<OutboxPullResult> = Promise.resolve(NOTHING_PULLED);

            await other.sql.begin(async (sql) => {
                await storeOn(sql).pause(PAUSE_MS);

                waiting = store.pull(10, WORKER);

                await waitForLockWaiters(observer, 1);
            });

            const answer = await waiting;

            expect(answer.messages).to.deep.equal([]);
            expect(answer.nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
        });

        // Counted from the start of their statements, taken before the wait, the second pull would
        // find the slot the first one moved due as well, and both would go out when the slow pull
        // commits.
        it("gives the pulls queued behind a pull slower than the cooldown one slot", async function () {
            const queuedLimits: TelegramLimits = { ...NO_LIMITS, common: { number: 1, interval: QUEUED_COOLDOWN_MS } };
            const limited = new OutboxStore(database, logger, queuedLimits, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));

            let queued: Promise<OutboxPullResult[]> = Promise.resolve([]);

            await other.sql.begin(async (sql) => {
                expect((await storeOn(sql, queuedLimits).pull(1, WORKER)).messages).to.have.lengthOf(1);

                await sleep(QUEUED_COOLDOWN_MS + TIMING_MARGIN_MS);
                const firstQueuedPull = limited.pull(1, WORKER);
                await waitForLockWaiters(observer, 1);

                await sleep(QUEUED_COOLDOWN_MS + TIMING_MARGIN_MS);
                const secondQueuedPull = limited.pull(1, WORKER);
                await waitForLockWaiters(observer, 2);

                queued = Promise.all([firstQueuedPull, secondQueuedPull]);
            });

            const pulled = (await queued).flatMap((answer) => answer.messages);

            expect(pulled).to.have.lengthOf(1);
        });

        // Checked by the start of its statement, taken before the wait, the chat would not be due
        // yet, and the pull would answer zero with a slot of the common limit to spend.
        it("takes a chat that came due while the pull waited for the bot row", async function () {
            const [, cameDueMessageId] = await store.pushBatch([message(OTHER_CHAT, "held"), message(CHAT, "due later")]);

            await database.sql`
                UPDATE telegram_outbox_chats
                SET next_attempt_at = now() + ${DUE_LATER_MS}::double precision * interval '1 millisecond'
                WHERE chat_id = ${CHAT}
            `;

            let waiting: Promise<OutboxPullResult> = Promise.resolve(NOTHING_PULLED);

            await other.sql.begin(async (sql) => {
                expect((await storeOn(sql).pull(1, WORKER)).messages).to.have.lengthOf(1);

                waiting = store.pull(10, WORKER);
                await waitForLockWaiters(observer, 1);

                await sleep(DUE_LATER_MS + TIMING_MARGIN_MS);
            });

            expect((await waiting).messages.map(({ id }) => id)).to.deep.equal([cameDueMessageId]);
        });

        it("lets the pull through once the pause is over", async function () {
            const id = await store.push(message(CHAT, "text"));

            await store.pause(SHORT_PAUSE_MS);
            await sleep(2 * SHORT_PAUSE_MS);

            expect((await store.pull(10, WORKER)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });

        it("resumes the pull after a pause with one slot of the common limit, not a burst", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            await limited.pause(SHORT_PAUSE_MS);
            await sleep(2 * SHORT_PAUSE_MS);

            expect((await limited.pull(10, WORKER)).messages).to.have.lengthOf(1);
        });

        // 1e17 ms is finite, but overflows the interval PostgreSQL adds to now().
        for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e17]) {
            it(`refuses a pause of ${durationMs} ms and changes nothing`, async function () {
                const error = await store.pause(durationMs).then(
                    () => expect.fail("pause() was expected to reject"),
                    (reason: unknown) => reason,
                );

                expect(error).to.be.instanceOf(InvalidPauseDuration);
                expect((error as InvalidPauseDuration).payload).to.deep.equal({ durationMs });
                expect(await pausedUntil()).to.equal(null);
            });
        }

        it("never shortens a pause, only lengthens it", async function () {
            await store.pause(PAUSE_MS);
            const paused = await pausedUntil();

            await store.pause(SHORTER_PAUSE_MS);
            expect(await pausedUntil()).to.deep.equal(paused);

            await store.pause(2 * PAUSE_MS);
            expect((await pausedUntil())?.getTime()).to.be.greaterThan(paused?.getTime() as number);
        });

        it("reports no next pull when no chat is ready", async function () {
            expect(await store.pull(10, WORKER)).to.deep.equal({ messages: [], nextPullInMs: null });

            await store.push(message(CHAT, "text"));

            expect((await store.pull(10, WORKER)).nextPullInMs).to.equal(null);
        });

        it("reports the next pull by the common cooldown when a ready chat was left out by the limit of the pull", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            expect((await limited.pull(1, WORKER)).nextPullInMs).to.equal(COMMON_COOLDOWN_MS);
        });

        it("reports the next pull by the nearest chat that waits for its interval", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2"), message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

            for (const pulled of (await limited.pull(10, WORKER)).messages) {
                await limited.markAsDone(pulled, RESPONSE);
            }

            expect((await limited.pull(10, WORKER)).nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);
        });

        it("reports the next pull by the pause when it ends after the chats are ready", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
            await limited.pause(PAUSE_MS);

            expect((await limited.pull(10, WORKER)).nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
        });

        // Both columns are the time of the last pull that took messages.
        async function nextSendAfterUpdateMs(): Promise<number> {
            const [row] = await database.sql<{ moved_ms: number }[]>`
                SELECT extract(epoch FROM next_send_at - updated_at)::double precision * ${MS_PER_SECOND} AS moved_ms
                FROM telegram_bot_limits
            `;

            return (row as { moved_ms: number }).moved_ms;
        }

        async function pausedUntil(): Promise<Date | null> {
            const [row] = await database.sql<{ paused_until: Date | null }[]>`SELECT paused_until FROM telegram_bot_limits`;

            return (row as { paused_until: Date | null }).paused_until;
        }
    });

    describe("the lease and the attempts", function () {
        it("leases the pulled chats under the token of the pull for the lease duration", async function () {
            await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            const pulled = (await store.pull(10, WORKER)).messages;
            const [lockToken] = pulled.map((pulledMessage) => pulledMessage.lockToken);
            // Both columns are the time of the pull.
            const rows = await database.sql<{ chat_id: string; lock_token: string; lease_ms: number }[]>`
                SELECT chat_id, lock_token, extract(epoch FROM locked_until - updated_at)::double precision * ${MS_PER_SECOND} AS lease_ms
                FROM telegram_outbox_chats
            `;
            const leases = rows.map((row) => ({ chatId: Number(row.chat_id), lockToken: row.lock_token, leaseMs: row.lease_ms }));

            expect(pulled.map((pulledMessage) => pulledMessage.lockToken)).to.deep.equal([lockToken, lockToken]);
            expect(leases).to.have.deep.members([
                { chatId: CHAT, lockToken, leaseMs: LEASE_DURATION_MS },
                { chatId: OTHER_CHAT, lockToken, leaseMs: LEASE_DURATION_MS },
            ]);
        });

        it("gives every pull a token of its own", async function () {
            await store.push(message(CHAT, "text"));
            const first = await pullOne();

            await store.retry(first, TRANSIENT, 0);

            expect((await pullOne()).lockToken).not.to.equal(first.lockToken);
        });

        it("writes no attempt on a pull and one of the worker, without an error, when the message is done", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            expect(await attempts(pulled.id)).to.deep.equal([]);
            expect(pulled.earlierAttempts).to.equal(0);

            await store.markAsDone(pulled, RESPONSE);
            const [attempt] = await attempts(pulled.id);

            expect(attempt).to.deep.include({
                started_at: pulled.startedAt,
                worker: { host: WORKER.host, pid: WORKER.pid, worker_id: WORKER.workerId },
                error: null,
            });
            expect((attempt?.finished_at as string) >= pulled.startedAt).to.equal(true);
        });

        it("ends the lease with the completion", async function () {
            await store.push(message(CHAT, "text"));
            await store.markAsDone(await pullOne(), RESPONSE);

            const [row] = await database.sql`SELECT locked_until, lock_token FROM telegram_outbox_chats`;

            expect(row).to.deep.equal({ locked_until: null, lock_token: null });
        });

        it("keeps every attempt of a message in the order they were made", async function () {
            await store.push(message(CHAT, "text"));

            await store.retry(await pullOne(), TRANSIENT, 0);
            const retried = await pullOne();
            await store.markAsDone(retried, RESPONSE);

            const history = await attempts(retried.id);

            expect(history.map(({ error }) => error)).to.deep.equal([TRANSIENT, null]);
            expect((history[0]?.finished_at as string) <= (history[1]?.started_at as string)).to.equal(true);
        });

        it("gives out the number of earlier attempts with a pull, whatever they ended with", async function () {
            await store.push(message(CHAT, "text"));

            await store.retry(await pullOne(), TRANSIENT, 0);
            await store.retry(await pullOne(), FLOOD, 0);

            expect((await pullOne()).earlierAttempts).to.equal(2);
        });
    });

    describe("a stale lock token", function () {
        // Another pull has taken the chat over: the recovery of an expired lease gave it to it.
        it("changes nothing when the lease has passed to another pull, and logs a warning", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await database.sql`UPDATE telegram_outbox_chats SET lock_token = gen_random_uuid()`;

            expect(await store.markAsDone(pulled, RESPONSE)).to.equal(false);
            await store.retry(pulled, TRANSIENT, 0);
            await store.markAsFailed(pulled, UNDELIVERABLE);
            await store.markAsFailedAndBlockChat(pulled, UNEXPECTED);

            expect(await statuses()).to.deep.equal([OutboxStatus.Processing]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Processing });
            expect(await attempts(pulled.id)).to.deep.equal([]);
            expect(logger.warnings).to.deep.equal(
                [null, TRANSIENT, UNDELIVERABLE, UNEXPECTED].map((cause) => ({
                    message: "Outbox completion with a stale lock token changed nothing.",
                    payload: { messageId: pulled.id, lockToken: pulled.lockToken, cause },
                })),
            );
            expect(logger.errors).to.deep.equal([]);
        });

        it("changes nothing on a second completion of the same pull", async function () {
            await store.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);
            const pulled = await pullOne();

            await store.markAsDone(pulled, RESPONSE);
            await store.markAsFailedAndBlockChat(pulled, UNEXPECTED);

            expect(await statuses()).to.deep.equal([OutboxStatus.Done, OutboxStatus.Pending]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(logger.warnings).to.have.lengthOf(1);
        });

        it("changes nothing for a token no pull gave out", async function () {
            const id = await store.push(message(CHAT, "text"));

            await store.markAsDone(lease(id, OTHER_TOKEN), RESPONSE);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(logger.warnings).to.have.lengthOf(1);
        });

        it("changes nothing for a chat the cleanup removed once it went idle, and logs a warning", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await store.markAsDone(pulled, RESPONSE);
            await store.deleteIdleChats();
            await store.markAsFailedAndBlockChat(pulled, UNEXPECTED);

            expect(await statuses()).to.deep.equal([OutboxStatus.Done]);
            expect(await chat(CHAT)).to.equal(undefined);
            expect(logger.warnings).to.deep.equal([
                {
                    message: "Outbox completion of a chat the cleanup removed changed nothing.",
                    payload: { messageId: pulled.id, lockToken: pulled.lockToken, cause: UNEXPECTED },
                },
            ]);
            expect(logger.errors).to.deep.equal([]);
        });

        it("says a done message of a chat the cleanup removed is not done by this completion", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await store.markAsDone(pulled, RESPONSE);
            await store.deleteIdleChats();

            expect(await store.markAsDone(pulled, RESPONSE)).to.equal(false);
        });
    });

    describe("expired leases", function () {
        beforeEach(function () {
            store = new OutboxStore(database, logger, NO_LIMITS, SHORT_LEASE_MS, CLEANUP);
        });

        // The only message of CHAT, pulled and left until its lease passes, and the lease the
        // recovery reads for it.
        async function pullAndExpire(): Promise<{ pulled: PulledOutboxMessage; expired: ExpiredOutboxLease }> {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();
            await sleep(SHORT_LEASE_MS * 2);
            const expiredLeases = await store.findExpiredLeases();

            expect(expiredLeases).to.have.lengthOf(1);

            return { pulled, expired: expiredLeases[0] as ExpiredOutboxLease };
        }

        it("finds a chat whose lease has passed with its message, the start of the pull and no worker", async function () {
            await store.pushBatch([message(CHAT, "head"), message(CHAT, "behind")]);
            await store.retry(await pullOne(), TRANSIENT, 0);
            const pulled = await pullOne();
            await sleep(SHORT_LEASE_MS * 2);

            expect(await store.findExpiredLeases()).to.deep.equal([
                { id: pulled.id, lockToken: pulled.lockToken, startedAt: pulled.startedAt, worker: null, earlierAttempts: 1 },
            ]);
        });

        it("leaves alone a lease that has not passed and a chat that is not leased", async function () {
            await store.push(message(CHAT, "expired"));
            const expired = await pullOne();
            const longLeasing = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP);
            const leased = await longLeasing.push(message(OTHER_CHAT, "leased"));
            expect((await longLeasing.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([leased]);
            await store.push(message(READY_CHAT, "ready"));
            await sleep(SHORT_LEASE_MS * 2);

            expect((await store.findExpiredLeases()).map(({ id }) => id)).to.deep.equal([expired.id]);
        });

        it("takes the message of an expired lease back to pending with an attempt that has no worker", async function () {
            const { pulled, expired } = await pullAndExpire();

            await store.retry(expired, EXPIRED_LEASE_ERROR, 0);

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(attempt).to.deep.include({ started_at: pulled.startedAt, worker: null, error: EXPIRED_LEASE_ERROR });
            expect((await pullOne()).earlierAttempts).to.equal(1);
        });

        it("fails the message of an expired lease and blocks its chat", async function () {
            const { pulled, expired } = await pullAndExpire();

            await store.markAsFailedAndBlockChat(expired, EXPIRED_LEASE_ERROR);

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Failed]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Blocked });
            expect(attempt).to.deep.include({ worker: null, error: EXPIRED_LEASE_ERROR });
        });

        it("changes nothing on a completion of the node presumed dead or a second recovery", async function () {
            const { pulled, expired } = await pullAndExpire();

            await store.retry(expired, EXPIRED_LEASE_ERROR, LONG_RETRY_DELAY_MS);
            await store.markAsDone(pulled, RESPONSE);
            await store.retry(expired, EXPIRED_LEASE_ERROR, 0);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await attempts(pulled.id)).to.have.lengthOf(1);
            expect(logger.warnings.map(({ payload }) => payload?.["cause"])).to.deep.equal([null, EXPIRED_LEASE_ERROR]);
        });
    });

    // The release is OutboxFailureHandler's decision over a completion of the store: the handler
    // runs over the real store here, so the specs pin what the release writes.
    describe("a release on stop", function () {
        // A handler over the store of the spec, with a retry delay of an hour and a limit of one
        // attempt: a release that applied either would leave the message out of the next pull.
        function handlerOver(releasingStore: OutboxStore): OutboxFailureHandler {
            return new OutboxFailureHandler(
                releasingStore,
                new TelegramBotApiFailureClassifier(),
                new OutboxRetryDelay({ firstDelayMs: HOUR_MS, maxDelayMs: HOUR_MS, multiplier: 1 }),
                new OutboxErrorSerializer("unused-token"),
                logger,
                1,
            );
        }

        it("returns the message to pending and ends the lease of its chat", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await handlerOver(store).releaseOnStop(pulled);

            const [row] = await database.sql`SELECT state, locked_until, lock_token FROM telegram_outbox_chats`;

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(row).to.deep.equal({ state: OutboxChatState.Ready, locked_until: null, lock_token: null });
        });

        it("lets a pull on another client take the released message at once, with the release counted as an attempt", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();
            const otherNode = new OutboxStore(other, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP);

            await handlerOver(store).releaseOnStop(pulled);
            const pulledAgain = (await otherNode.pull(10, WORKER)).messages;

            expect(pulledAgain.map(({ id, earlierAttempts }) => ({ id, earlierAttempts }))).to.deep.equal([
                { id: pulled.id, earlierAttempts: 1 },
            ]);
        });

        it("wakes the nodes that sleep with nothing to pull once the message is ready again", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();
            const payloads = await listenTo(other, OutboxChannel.Ready);

            await handlerOver(store).releaseOnStop(pulled);

            await waitUntil(() => payloads.length > 0, "no ready notification came");
            expect(payloads).to.deep.equal([""]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
        });

        it("closes the attempt of the pull with a transient error of the stopped node", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await handlerOver(store).releaseOnStop(pulled);

            const [attempt] = await attempts(pulled.id);

            expect(attempt).to.deep.include({
                started_at: pulled.startedAt,
                worker: { host: WORKER.host, pid: WORKER.pid, worker_id: WORKER.workerId },
            });
            expect(attempt?.error).to.deep.include({ name: "OutboxNodeStopped", kind: TelegramBotApiFailureKind.Transient });
        });

        it("keeps the chat limit the pull set", async function () {
            const limitedStore = new OutboxStore(
                database,
                logger,
                { common: NO_LIMIT, private: { number: 1, interval: HOUR_MS }, group: NO_LIMIT },
                LEASE_DURATION_MS,
                CLEANUP,
            );
            await limitedStore.push(message(CHAT, "text"));
            const [pulled] = (await limitedStore.pull(10, WORKER)).messages;

            await handlerOver(limitedStore).releaseOnStop(pulled as PulledOutboxMessage);

            // Released, so the empty pull below is the chat limit, not a message left processing.
            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect((await limitedStore.pull(10, WORKER)).messages).to.deep.equal([]);
        });

        it("changes nothing under a stale token, wakes no one and logs a warning", async function () {
            await store.push(message(CHAT, "text"));
            const stale = await pullOne();
            await store.retry(stale, TRANSIENT, 0);
            const current = await pullOne();
            const payloads = await listenTo(other, OutboxChannel.Ready);

            await handlerOver(store).releaseOnStop(stale);
            // PostgreSQL delivers the notifications in the order of the commits: a notification of
            // the release would come before this one.
            await database.sql`SELECT pg_notify(${OutboxChannel.Ready}, 'after the release')`;

            await waitUntil(() => payloads.length > 0, "no ready notification came");
            expect(payloads).to.deep.equal(["after the release"]);

            expect(await statuses()).to.deep.equal([OutboxStatus.Processing]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Processing });
            expect(await attempts(current.id)).to.have.lengthOf(1);
            expect(logger.warnings.map(({ message: warning, payload }) => ({ warning, lockToken: payload?.["lockToken"] }))).to.deep.equal([
                { warning: "Outbox completion with a stale lock token changed nothing.", lockToken: stale.lockToken },
            ]);
        });
    });

    describe("outcomes", function () {
        it("returns a retried message to pending and closes its attempt with the error", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await store.retry(pulled, TRANSIENT, LONG_RETRY_DELAY_MS);

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await isFinished(pulled.id)).to.equal(false);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(attempt?.finished_at).to.be.a("string");
            expect(attempt?.error).to.deep.equal(TRANSIENT);
        });

        it("holds the chat of a head waiting for its retry and lets the other chats through", async function () {
            const [head] = await store.pushBatch([message(CHAT, "head"), message(CHAT, "behind")]);
            await store.retry(await pullOne(), TRANSIENT, LONG_RETRY_DELAY_MS);
            const other = await store.push(message(OTHER_CHAT, "other"));

            const waiting = await store.pull(10, WORKER);

            expect(waiting.messages.map(({ id }) => id)).to.deep.equal([other]);
            expect(waiting.nextPullInMs).to.be.within(LONG_RETRY_DELAY_MS - ELAPSED_TOLERANCE_MS, LONG_RETRY_DELAY_MS);

            await database.sql`UPDATE telegram_outbox_chats SET next_attempt_at = now() WHERE chat_id = ${CHAT}`;

            expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([head]);
        });

        it("fails an undeliverable message and goes on to the next message of its chat", async function () {
            const [, behind] = await store.pushBatch([message(CHAT, "undeliverable"), message(CHAT, "behind")]);
            const pulled = await pullOne();

            await store.markAsFailed(pulled, UNDELIVERABLE);

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Failed, OutboxStatus.Pending]);
            expect(await isFinished(pulled.id)).to.equal(true);
            expect(attempt?.error).to.deep.equal(UNDELIVERABLE);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect((await pullOne()).id).to.equal(behind);
            expect(logger.errors).to.deep.equal([]);
        });

        it("leaves a chat idle when its last message fails without blocking it", async function () {
            await store.push(message(CHAT, "undeliverable"));

            await store.markAsFailed(await pullOne(), UNDELIVERABLE);

            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Idle });
            expect((await store.pull(10, WORKER)).messages).to.deep.equal([]);
        });

        it("fails a message and blocks its chat, the messages behind it and the new ones included", async function () {
            await store.pushBatch([message(CHAT, "failed"), message(CHAT, "behind")]);
            const pulled = await pullOne();

            await store.markAsFailedAndBlockChat(pulled, UNEXPECTED);
            await store.push(message(CHAT, "new"));

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Failed, OutboxStatus.Pending, OutboxStatus.Pending]);
            expect(await isFinished(pulled.id)).to.equal(true);
            expect(attempt?.error).to.deep.equal(UNEXPECTED);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Blocked });
            expect(await store.pull(10, WORKER)).to.deep.equal({ messages: [], nextPullInMs: null });
            expect(logger.errors).to.deep.equal([
                {
                    message: "Outbox chat is blocked by a failed message.",
                    payload: { chatId: CHAT, messageId: pulled.id, cause: UNEXPECTED },
                },
            ]);
        });
    });

    describe("without the row of the bot limits", function () {
        // The deleted row goes back as it was, so the spec does not repeat its id.
        let deletedRows: Record<string, unknown>[] = [];

        beforeEach(async function () {
            deletedRows = [...(await database.sql<Record<string, unknown>[]>`DELETE FROM telegram_bot_limits RETURNING *`)];
        });

        // A row lost before this block is not put back: an insert of nothing would throw an error of
        // its own over the cause, while the later pulls throw BotLimitsRowMissing, which names it.
        afterEach(async function () {
            if (deletedRows.length > 0) {
                await database.sql`INSERT INTO telegram_bot_limits ${database.sql(deletedRows)} ON CONFLICT DO NOTHING`;
            }

            deletedRows = [];
        });

        it("refuses a pull instead of reporting that no chat is ready", async function () {
            await store.push(message(CHAT, "text"));

            const error = await store.pull(10, WORKER).then(
                () => expect.fail("pull() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.be.instanceOf(BotLimitsRowMissing);
        });

        it("refuses a pause instead of changing nothing", async function () {
            const error = await store.pause(1).then(
                () => expect.fail("pause() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.be.instanceOf(BotLimitsRowMissing);
        });
    });

    describe("a concurrent push and completion", function () {
        // The third client holds the chat row, the store calls queue up behind it in a known order,
        // and the order decides which of them sees the other.
        async function race(first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> {
            let calls: Promise<unknown> = Promise.resolve();

            // The transaction commits on return and lets the waiting calls through.
            await other.sql.begin(async (sql) => {
                await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

                const firstCall = first();

                await waitForLockWaiters(observer, 1);

                calls = Promise.all([firstCall, second()]);

                await waitForLockWaiters(observer, 2);
            });

            await calls;
        }

        let processing: PulledOutboxMessage;
        let pushed: number | undefined;

        beforeEach(async function () {
            await store.push(message(CHAT, "processing", 1));
            pushed = undefined;
            processing = await pullOne();
        });

        const push = async (): Promise<void> => {
            pushed = await store.push(message(CHAT, "pushed", 4));
        };
        const complete = async (): Promise<void> => {
            await store.markAsDone(processing, RESPONSE);
        };

        it("leaves the chat ready with the new head when the push locks the chat first", async function () {
            await race(push, complete);

            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([pushed]);
        });

        it("leaves the chat ready with the new head when the completion locks the chat first", async function () {
            await race(complete, push);

            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect((await store.pull(10, WORKER)).messages.map(({ id }) => id)).to.deep.equal([pushed]);
        });
    });

    describe("the cleanup of finished messages", function () {
        // Finished messages by status, each ended the given time ago.
        async function finishedAgo(...rows: Array<{ status: OutboxStatus; agoMs: number }>): Promise<number[]> {
            const ids = await store.pushBatch(rows.map((_, index) => message(CHAT, `finished ${index}`)));

            for (const [index, { status, agoMs }] of rows.entries()) {
                await database.sql`
                    UPDATE telegram_outbox
                    SET status = ${status},
                        finished_at = now() - ${agoMs}::double precision * interval '1 millisecond'
                    WHERE id = ${ids[index] as number}
                `;
            }

            return ids;
        }

        async function ids(): Promise<number[]> {
            const rows = await database.sql<{ id: string }[]>`SELECT id FROM telegram_outbox ORDER BY id`;

            return rows.map((row) => Number(row.id));
        }

        // A minute on either side of a retention: far more than the spec takes to run.
        const MARGIN_MS = 60 * MS_PER_SECOND;

        it("deletes a done message once its retention has passed and keeps a younger one", async function () {
            const [, younger] = await finishedAgo(
                { status: OutboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS },
                { status: OutboxStatus.Done, agoMs: CLEANUP.doneRetentionMs - MARGIN_MS },
            );

            expect(await store.deleteFinishedMessages()).to.equal(1);
            expect(await ids()).to.deep.equal([younger]);
        });

        it("keeps a skipped message for its own retention, not that of a done one", async function () {
            const [, younger] = await finishedAgo(
                { status: OutboxStatus.Skipped, agoMs: CLEANUP.skippedRetentionMs + MARGIN_MS },
                { status: OutboxStatus.Skipped, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS },
            );

            expect(await store.deleteFinishedMessages()).to.equal(1);
            expect(await ids()).to.deep.equal([younger]);
        });

        it("never deletes a failed message or an active one, however old", async function () {
            const ages = [OutboxStatus.Failed, OutboxStatus.Pending, OutboxStatus.Processing].map((status) => ({
                status,
                agoMs: 1000 * CLEANUP.skippedRetentionMs,
            }));
            const kept = await finishedAgo(...ages);

            expect(await store.deleteFinishedMessages()).to.equal(0);
            expect(await ids()).to.deep.equal(kept);
        });

        it("never deletes a done or a skipped message without its end", async function () {
            const kept = await finishedAgo(
                { status: OutboxStatus.Done, agoMs: 1000 * CLEANUP.skippedRetentionMs },
                { status: OutboxStatus.Skipped, agoMs: 1000 * CLEANUP.skippedRetentionMs },
            );
            await database.sql`UPDATE telegram_outbox SET finished_at = NULL`;

            expect(await store.deleteFinishedMessages()).to.equal(0);
            expect(await ids()).to.deep.equal(kept);
        });

        // Another cleanup, or a person moving the message back by hand, holds the row.
        it("skips a message another transaction holds and deletes the rest", async function () {
            const old = { status: OutboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS };
            const [held] = await finishedAgo(old, old);
            let deleted = 0;

            await other.sql.begin(async (sql) => {
                await sql`SELECT id FROM telegram_outbox WHERE id = ${held as number} FOR UPDATE`;

                deleted = await store.deleteFinishedMessages();
            });

            expect(deleted).to.equal(1);
            expect(await ids()).to.deep.equal([held]);
        });

        it("deletes no more messages in one call than the batch size", async function () {
            const batched = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, { ...CLEANUP, batchSize: 2 });
            const old = { status: OutboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS };
            await finishedAgo(old, old, old);

            expect(await batched.deleteFinishedMessages()).to.equal(2);
            expect(await ids()).to.have.lengthOf(1);
            expect(await batched.deleteFinishedMessages()).to.equal(1);
            expect(await ids()).to.deep.equal([]);
        });

        it("takes the longest retention the config allows without overflowing a timestamp", async function () {
            const longest = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, {
                doneRetentionMs: Number.MAX_SAFE_INTEGER,
                skippedRetentionMs: Number.MAX_SAFE_INTEGER,
                batchSize: 10,
            });
            await finishedAgo({ status: OutboxStatus.Done, agoMs: 0 }, { status: OutboxStatus.Skipped, agoMs: 0 });

            expect(await longest.deleteFinishedMessages()).to.equal(0);
        });
    });

    describe("the cleanup of idle chats", function () {
        async function idleChat(chatId: number): Promise<void> {
            await store.push(message(chatId, "done"));
            await store.markAsDone(await pullOne(), RESPONSE);
        }

        it("removes an idle chat and leaves its messages", async function () {
            await idleChat(CHAT);

            expect(await store.deleteIdleChats()).to.equal(1);
            expect(await chat(CHAT)).to.equal(undefined);
            expect(await statuses()).to.deep.equal([OutboxStatus.Done]);
        });

        it("keeps a ready, a processing and a blocked chat", async function () {
            const [blockedChat, processingChat, readyChat] = [1, 2, 3];
            await store.push(message(blockedChat, "failed"));
            await store.markAsFailedAndBlockChat(await pullOne(), UNEXPECTED);
            await store.push(message(processingChat, "processing"));
            await pullOne();
            await store.push(message(readyChat, "pending"));

            expect(await store.deleteIdleChats()).to.equal(0);
            expect(await chat(blockedChat)).to.deep.equal({ state: OutboxChatState.Blocked });
            expect(await chat(processingChat)).to.deep.equal({ state: OutboxChatState.Processing });
            expect(await chat(readyChat)).to.deep.equal({ state: OutboxChatState.Ready });
        });

        // A push recreates the chat with next_attempt_at of now(), so a row removed earlier would let
        // the next message out before the limit.
        it("keeps an idle chat until its chat limit has passed", async function () {
            const limited = new OutboxStore(
                database,
                logger,
                { ...NO_LIMITS, private: { number: 1, interval: HOUR_MS } },
                LEASE_DURATION_MS,
                CLEANUP,
            );
            await limited.push(message(CHAT, "done"));
            const [pulled] = (await limited.pull(1, WORKER)).messages;
            await limited.markAsDone(pulled as PulledOutboxMessage, RESPONSE);

            expect(await limited.deleteIdleChats()).to.equal(0);

            await database.sql`UPDATE telegram_outbox_chats SET next_attempt_at = now()`;

            expect(await limited.deleteIdleChats()).to.equal(1);
        });

        it("removes no more chats in one call than the batch size", async function () {
            const batched = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, { ...CLEANUP, batchSize: 2 });
            for (const chatId of [1, 2, 3]) {
                await idleChat(chatId);
            }

            expect(await batched.deleteIdleChats()).to.equal(2);
            expect(await batched.deleteIdleChats()).to.equal(1);
        });
    });

    describe("a concurrent push and removal of its chat", function () {
        beforeEach(async function () {
            await store.push(message(CHAT, "done"));
            await store.markAsDone(await pullOne(), RESPONSE);
        });

        // The holder stands in for a push or a completion of the chat.
        it("leaves a chat another transaction holds to it", async function () {
            let removed = -1;

            await other.sql.begin(async (sql) => {
                await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

                removed = await store.deleteIdleChats();
            });

            expect(removed).to.equal(0);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Idle });
        });

        // The removal runs in the transaction that holds the chat, so it takes the chat while the push
        // waits for it. A push that found the row in one statement and locked it in the next would
        // find it gone and put its messages in without a chat, where no pull reaches them.
        it("recreates the chat and keeps the order of a push that waited for its removal", async function () {
            let pushing: Promise<number[]> = Promise.resolve([]);
            let removed = 0;

            await other.sql.begin(async (sql) => {
                await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

                pushing = store.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);

                await waitForLockWaiters(observer, 1);

                removed = await storeOn(sql).deleteIdleChats();
            });

            const pushed = await pushing;

            expect(removed).to.equal(1);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(await drain(store)).to.deep.equal(pushed);
        });
    });

    describe("notifications", function () {
        // A client of its own per test: closed at the end, it takes its LISTEN connection along, so
        // the next test counts only its own.
        let listener: Database;

        beforeEach(function () {
            listener = new Database(settings, false);
        });

        afterEach(async function () {
            await listener.close();
        });

        it("notifies the ready channel when a push commits", async function () {
            const payloads = await listenTo(listener, OutboxChannel.Ready);

            await store.pushBatch([message(CHAT, "first"), message(OTHER_CHAT, "second")]);

            await waitUntil(() => payloads.length > 0, "no ready notification came");
            expect(payloads).to.deep.equal([""]);
        });

        it("calls the ready listener when the listening starts and when a push commits", async function () {
            let readyCount = 0;
            await new OutboxStore(listener, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP).listenReady(() => (readyCount += 1));

            expect(readyCount).to.equal(1);

            await store.push(message(CHAT, "first"));

            await waitUntil(() => readyCount === 2, "no ready notification came");
        });

        it("notifies the finished channel with the id of a message marked as done", async function () {
            const payloads = await listenTo(listener, OutboxChannel.Finished);
            const id = await store.push(message(CHAT, "first"));

            await store.markAsDone(await pullOne(), RESPONSE);

            await waitUntil(() => payloads.length > 0, "no finished notification came");
            expect(payloads).to.deep.equal([String(id)]);
        });

        it("notifies the finished channel with the id of a message marked as failed", async function () {
            const payloads = await listenTo(listener, OutboxChannel.Finished);
            const id = await store.push(message(CHAT, "first"));

            await store.markAsFailed(await pullOne(), UNDELIVERABLE);

            await waitUntil(() => payloads.length > 0, "no finished notification came");
            expect(payloads).to.deep.equal([String(id)]);
        });

        it("notifies the finished channel with the id of a message failed with its chat blocked", async function () {
            const payloads = await listenTo(listener, OutboxChannel.Finished);
            const id = await store.push(message(CHAT, "first"));

            await store.markAsFailedAndBlockChat(await pullOne(), UNDELIVERABLE);

            await waitUntil(() => payloads.length > 0, "no finished notification came");
            expect(payloads).to.deep.equal([String(id)]);
        });

        it("does not notify the finished channel of a retry", async function () {
            const payloads = await listenTo(listener, OutboxChannel.Finished);
            await store.push(message(CHAT, "first"));
            const done = await store.push(message(OTHER_CHAT, "second"));
            const [retried, finished] = (await store.pull(10, WORKER)).messages;

            await store.retry(retried as PulledOutboxMessage, UNDELIVERABLE, 0);
            await store.markAsDone(finished as PulledOutboxMessage, RESPONSE);

            await waitUntil(() => payloads.length > 0, "no finished notification came");
            expect(payloads).to.deep.equal([String(done)]);
        });
    });

    // A store whose statements run in the given transaction.
    function storeOn(transaction: TransactionSql, limits: TelegramLimits = NO_LIMITS): OutboxStore {
        return new OutboxStore({ sql: transaction } as unknown as Database, logger, limits, LEASE_DURATION_MS, CLEANUP);
    }

    async function chat(chatId: number): Promise<ChatRow | undefined> {
        const [row] = await database.sql<ChatRow[]>`
            SELECT state
            FROM telegram_outbox_chats
            WHERE chat_id = ${chatId}
        `;

        return row;
    }

    async function expectNotLeased(lease: OutboxLease): Promise<void> {
        const error = await store.markAsDone(lease, RESPONSE).then(
            () => expect.fail("markAsDone() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(OutboxMessageNotLeased);
        expect((error as OutboxMessageNotLeased).payload).to.deep.equal({ messageId: lease.id });
    }

    // A lease the spec makes up rather than takes from a pull.
    function lease(id: number, lockToken: string): OutboxLease {
        return { id, lockToken, startedAt: "2026-09-29T10:00:00.000000+00:00", worker: WORKER };
    }

    // The only message a pull gives out.
    async function pullOne(): Promise<PulledOutboxMessage> {
        const { messages } = await store.pull(10, WORKER);

        expect(messages).to.have.lengthOf(1);

        return messages[0] as PulledOutboxMessage;
    }

    async function attempts(messageId: number): Promise<OutboxAttempt[]> {
        const [row] = await database.sql<{ attempts: OutboxAttempt[] }[]>`SELECT attempts FROM telegram_outbox WHERE id = ${messageId}`;

        return (row as { attempts: OutboxAttempt[] }).attempts;
    }

    async function isFinished(messageId: number): Promise<boolean> {
        const [row] = await database.sql<
            { finished: boolean }[]
        >`SELECT finished_at IS NOT NULL AS finished FROM telegram_outbox WHERE id = ${messageId}`;

        return (row as { finished: boolean }).finished;
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_outbox ORDER BY id`;

        return rows.map((row) => row.status);
    }
});

function message(chatId: number, text: string, priority = 0): OutboxMessageInput {
    return { chatId, method: "sendMessage", payload: { chat_id: chatId, text }, priority };
}

// Pulls one message at a time and marks it done until the outbox is empty; the ids in pull order.
async function drain(store: OutboxStore): Promise<number[]> {
    const ids: number[] = [];

    for (;;) {
        const [pulled] = (await store.pull(1, WORKER)).messages;

        if (pulled === undefined) {
            return ids;
        }

        ids.push(pulled.id);
        await store.markAsDone(pulled, RESPONSE);
    }
}
