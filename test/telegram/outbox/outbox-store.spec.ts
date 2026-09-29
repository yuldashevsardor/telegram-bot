import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { TransactionSql } from "postgres";
import { Database } from "app/platform/database/database";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type {
    OutboxAttemptError,
    OutboxLease,
    OutboxMessageInput,
    OutboxWorker,
    PulledOutboxMessage,
} from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { InvalidPauseDuration, OutboxMessageNotProcessing } from "app/telegram/outbox/store/outbox-store.errors";
import { MS_PER_SECOND } from "app/shared/time";
import { sleep } from "app/shared/utils";
import { testDatabaseSettings } from "test/database.helper";

const CHAT = 5_000_000_001;
const OTHER_CHAT = -1_001_234_567_890;
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
// A token no pull gave out.
const OTHER_TOKEN = "00000000-0000-4000-8000-000000000000";
// Longer than any spec runs: a chat retried with it is not pulled again by the spec.
const LONG_RETRY_DELAY_MS = 60_000;

type ChatRow = { state: string };
type Attempt = { started_at?: string; finished_at?: string; worker?: unknown; error?: unknown };
type LogRecord = { message: string; payload: UnknownObject | undefined };

class RecordingLogger implements Logger {
    public readonly errors: LogRecord[] = [];
    public readonly warnings: LogRecord[] = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(message: string, payload?: UnknownObject): void {
        this.warnings.push({ message: message, payload: payload });
    }

    public info(): void {}

    public debug(): void {}
}

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

    before(async function () {
        const settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
        observer = new Database(settings, false);
    });

    beforeEach(async function () {
        logger = new RecordingLogger();
        store = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS);
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

    it("stores the response and the end of a done message", async function () {
        const id = await store.push(message(CHAT, "text"));

        await store.markAsDone(await pullOne(), RESPONSE);

        const [row] = await database.sql<{ status: string; response: unknown; finished: boolean }[]>`
            SELECT status, response, finished_at IS NOT NULL AS finished
            FROM telegram_outbox
            WHERE id = ${id}
        `;

        expect(row).to.deep.equal({ status: OutboxStatus.Done, response: RESPONSE, finished: true });
    });

    it("refuses to mark done a message that does not exist", async function () {
        await expectNotProcessing({ id: 404, lockToken: OTHER_TOKEN });
    });

    it("refuses a lease of its chat that names another message of the chat and changes nothing", async function () {
        const [, second] = await store.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);
        const pulled = await pullOne();

        await expectNotProcessing({ id: second as number, lockToken: pulled.lockToken });
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

            await waitForLockWaiters(1);

            passing = await store.push(message(OTHER_CHAT, "passing"));
        });

        expect(await waiting).to.be.greaterThan(passing);
    });

    // A pull inside a transaction of the other client keeps what it locked until the commit, as a
    // pull on another node does for the length of its statement.
    it("gives out nothing while another pull holds the bot row", async function () {
        await store.pushBatch([message(CHAT, "held"), message(OTHER_CHAT, "waiting")]);

        await other.sql.begin(async (sql) => {
            expect((await storeOn(sql).pull(1, WORKER)).messages).to.have.lengthOf(1);

            expect((await store.pull(10, WORKER)).messages).to.deep.equal([]);
        });
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

        await Promise.all([puller(store), puller(new OutboxStore(other, logger, NO_LIMITS, LEASE_DURATION_MS))]);

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

        it("gives a chat no message before its interval has passed", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS);
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
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS);

            await limited.push(message(CHAT, "text"));
            const [pulled] = (await limited.pull(10, WORKER)).messages;

            await limited.retry(pulled as PulledOutboxMessage, TRANSIENT, 0);

            const early = await limited.pull(10, WORKER);

            expect(early.messages).to.deep.equal([]);
            expect(early.nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);
        });

        it("moves a pulled chat by the interval of a private chat or a group, by the sign of its id", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch([message(CHAT, "private"), message(OTHER_CHAT, "group")]);
            await limited.pull(10, WORKER);

            // Both columns are now() of the pull.
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
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));

            expect((await limited.pull(10, WORKER)).messages).to.have.lengthOf(COMMON_NUMBER);

            const spent = await limited.pull(10, WORKER);

            expect(spent.messages).to.deep.equal([]);
            expect(spent.nextPullInMs).to.be.within(COMMON_INTERVAL_MS - COMMON_COOLDOWN_MS, COMMON_INTERVAL_MS);
        });

        // Slots saved up and spent at once must not come due again inside the same interval: after a
        // burst of the whole limit a slot a cooldown later would put number + 1 messages in it.
        it("holds the next message back a cooldown per message of the batch, from the pull", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            await limited.pull(10, WORKER);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_INTERVAL_MS);

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now()`;
            await limited.pull(10, WORKER);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_COOLDOWN_MS);
        });

        it("gives out only the slots of the common limit that have come due", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS);

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

            const paused = await new OutboxStore(other, logger, NO_LIMITS, LEASE_DURATION_MS).pull(10, WORKER);

            expect(paused.messages).to.deep.equal([]);
            expect(paused.nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
            expect((await store.pull(10, WORKER)).messages).to.deep.equal([]);
        });

        it("lets the pull through once the pause is over", async function () {
            const id = await store.push(message(CHAT, "text"));

            await store.pause(SHORT_PAUSE_MS);
            await sleep(2 * SHORT_PAUSE_MS);

            expect((await store.pull(10, WORKER)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });

        it("resumes the pull after a pause with one slot of the common limit, not a burst", async function () {
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS);

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
            const limited = new OutboxStore(database, logger, COMMON_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            expect((await limited.pull(1, WORKER)).nextPullInMs).to.equal(COMMON_COOLDOWN_MS);
        });

        it("reports the next pull by the nearest chat that waits for its interval", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2"), message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

            for (const pulled of (await limited.pull(10, WORKER)).messages) {
                await limited.markAsDone(pulled, RESPONSE);
            }

            expect((await limited.pull(10, WORKER)).nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);
        });

        it("reports the next pull by the pause when it ends after the chats are ready", async function () {
            const limited = new OutboxStore(database, logger, CHAT_LIMITS, LEASE_DURATION_MS);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
            await limited.pause(PAUSE_MS);

            expect((await limited.pull(10, WORKER)).nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
        });

        // Both columns are now() of the last pull that took messages.
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
        it("leases each pulled chat under a token of its own for the lease duration", async function () {
            await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            const pulled = (await store.pull(10, WORKER)).messages;
            // Both columns are now() of the pull.
            const rows = await database.sql<{ chat_id: string; lock_token: string; lease_ms: number }[]>`
                SELECT chat_id, lock_token, extract(epoch FROM locked_until - updated_at)::double precision * ${MS_PER_SECOND} AS lease_ms
                FROM telegram_outbox_chats
            `;
            const leases = rows.map((row) => ({ chatId: Number(row.chat_id), lockToken: row.lock_token, leaseMs: row.lease_ms }));

            expect(leases).to.have.deep.members(pulled.map(({ chatId, lockToken }) => ({ chatId, lockToken, leaseMs: LEASE_DURATION_MS })));
            expect(new Set(pulled.map(({ lockToken }) => lockToken)).size).to.equal(2);
        });

        it("opens an attempt of the worker on a pull and closes it without an error when the message is done", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            const [opened] = await attempts(pulled.id);

            expect(opened).to.have.all.keys("started_at", "worker");
            expect(opened?.worker).to.deep.equal({ host: WORKER.host, pid: WORKER.pid, worker_id: WORKER.workerId });

            await store.markAsDone(pulled, RESPONSE);
            const [closed] = await attempts(pulled.id);

            expect(closed).to.have.all.keys("started_at", "worker", "finished_at", "error");
            expect(closed?.error).to.equal(null);
            expect(closed?.started_at).to.equal(opened?.started_at);
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

        it("counts the failed attempts of a message except a flood", async function () {
            await store.push(message(CHAT, "text"));

            const first = await pullOne();
            await store.retry(first, TRANSIENT, 0);
            const second = await pullOne();
            await store.retry(second, FLOOD, 0);
            const third = await pullOne();
            await store.retry(third, TRANSIENT, 0);
            const fourth = await pullOne();

            expect([first, second, third, fourth].map(({ countedFailures }) => countedFailures)).to.deep.equal([0, 1, 1, 2]);
        });
    });

    describe("a stale lock token", function () {
        // Another pull has taken the chat over: the recovery of an expired lease gave it to it.
        it("changes nothing when the lease has passed to another pull, and logs a warning", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await database.sql`UPDATE telegram_outbox_chats SET lock_token = gen_random_uuid()`;

            await store.markAsDone(pulled, RESPONSE);
            await store.retry(pulled, TRANSIENT, 0);
            await store.markAsFailed(pulled, UNDELIVERABLE);
            await store.markAsFailedAndBlockChat(pulled, UNEXPECTED);

            expect(await statuses()).to.deep.equal([OutboxStatus.Processing]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Processing });
            expect(await attempts(pulled.id))
                .to.have.lengthOf(1)
                .and.to.satisfy((history: Attempt[]) => history[0]?.error === undefined);
            expect(logger.warnings).to.deep.equal(
                Array.from({ length: 4 }, () => ({
                    message: "Outbox completion with a stale lock token changed nothing.",
                    payload: { messageId: pulled.id, lockToken: pulled.lockToken },
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

            await store.markAsDone({ id, lockToken: OTHER_TOKEN }, RESPONSE);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(logger.warnings).to.have.lengthOf(1);
        });
    });

    describe("outcomes", function () {
        it("returns a retried message to pending and closes its attempt with the error", async function () {
            await store.push(message(CHAT, "text"));
            const pulled = await pullOne();

            await store.retry(pulled, TRANSIENT, LONG_RETRY_DELAY_MS);

            const [attempt] = await attempts(pulled.id);

            expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
            expect(await finished(pulled.id)).to.equal(false);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect(attempt).to.have.all.keys("started_at", "worker", "finished_at", "error");
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
            expect(await finished(pulled.id)).to.equal(true);
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
            expect(await finished(pulled.id)).to.equal(true);
            expect(attempt?.error).to.deep.equal(UNEXPECTED);
            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Blocked });
            expect(await store.pull(10, WORKER)).to.deep.equal({ messages: [], nextPullInMs: null });
            expect(logger.errors).to.deep.equal([
                {
                    message: "Outbox chat is blocked by a failed message.",
                    payload: { chatId: CHAT, messageId: pulled.id, failure: UNEXPECTED },
                },
            ]);
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

                await waitForLockWaiters(1);

                calls = Promise.all([firstCall, second()]);

                await waitForLockWaiters(2);
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

    // A store whose statements run in the given transaction.
    function storeOn(transaction: TransactionSql): OutboxStore {
        return new OutboxStore({ sql: transaction } as unknown as Database, logger, NO_LIMITS, LEASE_DURATION_MS);
    }

    async function chat(chatId: number): Promise<ChatRow | undefined> {
        const [row] = await database.sql<ChatRow[]>`
            SELECT state
            FROM telegram_outbox_chats
            WHERE chat_id = ${chatId}
        `;

        return row;
    }

    async function expectNotProcessing(lease: OutboxLease): Promise<void> {
        const error = await store.markAsDone(lease, RESPONSE).then(
            () => expect.fail("markAsDone() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(OutboxMessageNotProcessing);
        expect((error as OutboxMessageNotProcessing).payload).to.deep.equal({ messageId: lease.id });
    }

    // The only message a pull gives out.
    async function pullOne(): Promise<PulledOutboxMessage> {
        const { messages } = await store.pull(10, WORKER);

        expect(messages).to.have.lengthOf(1);

        return messages[0] as PulledOutboxMessage;
    }

    async function attempts(messageId: number): Promise<Attempt[]> {
        const [row] = await database.sql<{ attempts: Attempt[] }[]>`SELECT attempts FROM telegram_outbox WHERE id = ${messageId}`;

        return (row as { attempts: Attempt[] }).attempts;
    }

    async function finished(messageId: number): Promise<boolean> {
        const [row] = await database.sql<
            { finished: boolean }[]
        >`SELECT finished_at IS NOT NULL AS finished FROM telegram_outbox WHERE id = ${messageId}`;

        return (row as { finished: boolean }).finished;
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_outbox ORDER BY id`;

        return rows.map((row) => row.status);
    }

    async function waitForLockWaiters(count: number): Promise<void> {
        const deadline = Date.now() + WAIT_DEADLINE_MS;

        for (;;) {
            if (Date.now() > deadline) {
                expect.fail(`fewer than ${count} queries waited for a lock by the deadline`);
            }

            const [row] = await observer.sql<{ waiting: number }[]>`
                SELECT count(*)::int AS waiting
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
            `;

            if (row !== undefined && row.waiting >= count) {
                return;
            }

            await sleep(5);
        }
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
