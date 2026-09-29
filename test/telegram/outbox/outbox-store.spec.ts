import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { TransactionSql } from "postgres";
import { Database } from "app/platform/database/database";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { InvalidPauseDuration, OutboxMessageNotProcessing } from "app/telegram/outbox/store/outbox-store.errors";
import type { FinishedOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import { OutboxResultTimeout } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import type { FinishedMessageSource, OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { Logger } from "app/platform/logger/logger";
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
// The poll of the waiter specs that rely on it: many polls within a test.
const FAST_POLL_MS = 20;
// The timeout of the waiter spec that times out: over long before WAIT_DEADLINE_MS.
const SHORT_WAIT_TIMEOUT_MS = 50;

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
    let store: OutboxStore;
    let settings: DatabaseSettings;

    before(async function () {
        settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
        observer = new Database(settings, false);
        store = new OutboxStore(database, NO_LIMITS);
    });

    beforeEach(async function () {
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

        expect((await store.pull(10)).messages).to.deep.equal([
            { id, chatId: OTHER_CHAT, method: "sendPhoto", payload: { photo: "file-id", caption: null }, priority: 3 },
        ]);
    });

    it("never keeps two messages of a chat in processing", async function () {
        await store.pushBatch([message(CHAT, "first"), message(CHAT, "second"), message(CHAT, "third")]);

        expect((await store.pull(10)).messages).to.have.lengthOf(1);
        expect((await store.pull(10)).messages).to.deep.equal([]);
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

        expect((await store.pull(10)).messages.map(({ id }) => id)).to.deep.equal([a, b]);
    });

    it("pulls no more chats than the limit", async function () {
        await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

        expect((await store.pull(1)).messages).to.have.lengthOf(1);
    });

    // The priority of a chat is the priority of its head: a later, more urgent message of the same
    // chat does not move the chat ahead.
    it("pulls the chats by the priority of their head, not of their latest message", async function () {
        await store.pushBatch([message(CHAT, "head", 300), message(CHAT, "urgent", 100)]);
        const other = await store.push(message(OTHER_CHAT, "middle", 200));

        expect((await store.pull(1)).messages.map(({ id }) => id)).to.deep.equal([other]);
    });

    it("stores the response and the end of a done message", async function () {
        const id = await store.push(message(CHAT, "text"));

        await store.pull(10);
        await store.markAsDone(id, RESPONSE);

        const [row] = await database.sql<{ status: string; response: unknown; finished: boolean }[]>`
            SELECT status, response, finished_at IS NOT NULL AS finished
            FROM telegram_outbox
            WHERE id = ${id}
        `;

        expect(row).to.deep.equal({ status: OutboxStatus.Done, response: RESPONSE, finished: true });
    });

    it("refuses to mark done a message that is not processing and changes nothing", async function () {
        const id = await store.push(message(CHAT, "text"));

        await expectNotProcessing(id);
        expect(await statuses()).to.deep.equal([OutboxStatus.Pending]);
        expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });

        await store.pull(10);
        await store.markAsDone(id, RESPONSE);

        await expectNotProcessing(id);
        expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Idle });
    });

    it("refuses to mark done a message that does not exist", async function () {
        await expectNotProcessing(404);
    });

    it("takes a chat with a higher-priority head first", async function () {
        await store.push(message(CHAT, "later", 2));
        const urgent = await store.push(message(OTHER_CHAT, "urgent", 0));

        expect((await store.pull(1)).messages.map(({ id }) => id)).to.deep.equal([urgent]);
    });

    it("returns the pulled messages by priority, not by id", async function () {
        const later = await store.push(message(CHAT, "later", 2));
        const urgent = await store.push(message(OTHER_CHAT, "urgent", 0));

        expect((await store.pull(10)).messages.map(({ id }) => id)).to.deep.equal([urgent, later]);
    });

    // The chats of one pull get the same next_attempt_at: with NO_LIMITS the cooldown of a private
    // chat and of a group is a nanosecond, so both round to the time of the statement. Without the
    // chat_id key their next turn follows the order PostgreSQL meets the tied rows in, which tends to
    // be the order of completion: the spec completes them in both orders, and one of them fails then.
    for (const completedFirst of [CHAT, OTHER_CHAT]) {
        it(`takes the chats served in one pull by chat_id in the next turn, chat ${completedFirst} completed first`, async function () {
            await store.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
            await store.pushBatch([message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

            const pulled = (await store.pull(10)).messages;
            const first = pulled.filter(({ chatId }) => chatId === completedFirst);
            const rest = pulled.filter(({ chatId }) => chatId !== completedFirst);

            for (const { id } of [...first, ...rest]) {
                await store.markAsDone(id, RESPONSE);
            }

            expect((await store.pull(1)).messages.map(({ chatId }) => chatId)).to.deep.equal([OTHER_CHAT]);
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
            expect((await storeOn(sql).pull(1)).messages).to.have.lengthOf(1);

            expect((await store.pull(10)).messages).to.deep.equal([]);
        });
    });

    it("leaves the bot row to other pulls when it has no chat to pull", async function () {
        await other.sql.begin(async (sql) => {
            expect((await storeOn(sql).pull(10)).messages).to.deep.equal([]);

            const id = await store.push(message(CHAT, "text"));

            expect((await store.pull(10)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });
    });

    it("skips a chat another puller holds and takes the next one", async function () {
        await store.push(message(CHAT, "held"));
        const free = await store.push(message(OTHER_CHAT, "free"));

        await other.sql.begin(async (sql) => {
            await sql`SELECT chat_id FROM telegram_outbox_chats WHERE chat_id = ${CHAT} FOR UPDATE`;

            expect((await store.pull(10)).messages.map(({ id }) => id)).to.deep.equal([free]);
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

                const batch = (await client.pull(2)).messages;

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
                    await client.markAsDone(pulled.id, RESPONSE);
                }
            }
        };

        // A failed puller stops the other one, which would otherwise keep going after the test.
        const puller = (client: OutboxStore): Promise<void> =>
            pull(client).catch((error: unknown) => {
                hasFailed = true;
                throw error;
            });

        await Promise.all([puller(store), puller(new OutboxStore(other, NO_LIMITS))]);

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
        // How much of a long pause or interval the calls between its start and the pull may use up.
        const ELAPSED_TOLERANCE_MS = 1_000;

        it("gives a chat no message before its interval has passed", async function () {
            const limited = new OutboxStore(database, CHAT_LIMITS);
            const [first, second] = await limited.pushBatch([message(CHAT, "first"), message(CHAT, "second")]);

            await limited.pull(10);
            await limited.markAsDone(first as number, RESPONSE);

            const early = await limited.pull(10);

            expect(early.messages).to.deep.equal([]);
            expect(early.nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);

            await database.sql`UPDATE telegram_outbox_chats SET next_attempt_at = now()`;

            expect((await limited.pull(10)).messages.map(({ id }) => id)).to.deep.equal([second]);
        });

        it("moves a pulled chat by the interval of a private chat or a group, by the sign of its id", async function () {
            const limited = new OutboxStore(database, CHAT_LIMITS);

            await limited.pushBatch([message(CHAT, "private"), message(OTHER_CHAT, "group")]);
            await limited.pull(10);

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
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));

            expect((await limited.pull(10)).messages).to.have.lengthOf(COMMON_NUMBER);

            const spent = await limited.pull(10);

            expect(spent.messages).to.deep.equal([]);
            expect(spent.nextPullInMs).to.be.within(COMMON_INTERVAL_MS - COMMON_COOLDOWN_MS, COMMON_INTERVAL_MS);
        });

        // Slots saved up and spent at once must not come due again inside the same interval: after a
        // burst of the whole limit a slot a cooldown later would put number + 1 messages in it.
        it("holds the next message back a cooldown per message of the batch, from the pull", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            await limited.pull(10);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_INTERVAL_MS);

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now()`;
            await limited.pull(10);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_COOLDOWN_MS);
        });

        it("gives out only the slots of the common limit that have come due", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            // Two slots have come due: at next_send_at and a cooldown later; the third is half a
            // cooldown away.
            const twoSlotsAgoMs = COMMON_COOLDOWN_MS + COMMON_COOLDOWN_MS / 2;

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now() - ${twoSlotsAgoMs}::double precision * interval '1 millisecond'`;

            expect((await limited.pull(10)).messages).to.have.lengthOf(2);
        });

        it("stops the pull on every client while the pause lasts", async function () {
            await store.push(message(CHAT, "text"));
            await store.pause(PAUSE_MS);

            const paused = await new OutboxStore(other, NO_LIMITS).pull(10);

            expect(paused.messages).to.deep.equal([]);
            expect(paused.nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
            expect((await store.pull(10)).messages).to.deep.equal([]);
        });

        it("lets the pull through once the pause is over", async function () {
            const id = await store.push(message(CHAT, "text"));

            await store.pause(SHORT_PAUSE_MS);
            await sleep(2 * SHORT_PAUSE_MS);

            expect((await store.pull(10)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });

        it("resumes the pull after a pause with one slot of the common limit, not a burst", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch(MANY_CHAT_IDS.map((chatId) => message(chatId, "text")));
            await limited.pause(SHORT_PAUSE_MS);
            await sleep(2 * SHORT_PAUSE_MS);

            expect((await limited.pull(10)).messages).to.have.lengthOf(1);
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
            expect(await store.pull(10)).to.deep.equal({ messages: [], nextPullInMs: null });

            await store.push(message(CHAT, "text"));

            expect((await store.pull(10)).nextPullInMs).to.equal(null);
        });

        it("reports the next pull by the common cooldown when a ready chat was left out by the limit of the pull", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            expect((await limited.pull(1)).nextPullInMs).to.equal(COMMON_COOLDOWN_MS);
        });

        it("reports the next pull by the nearest chat that waits for its interval", async function () {
            const limited = new OutboxStore(database, CHAT_LIMITS);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2"), message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

            for (const { id } of (await limited.pull(10)).messages) {
                await limited.markAsDone(id, RESPONSE);
            }

            expect((await limited.pull(10)).nextPullInMs).to.be.within(1, PRIVATE_COOLDOWN_MS);
        });

        it("reports the next pull by the pause when it ends after the chats are ready", async function () {
            const limited = new OutboxStore(database, CHAT_LIMITS);

            await limited.pushBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
            await limited.pause(PAUSE_MS);

            expect((await limited.pull(10)).nextPullInMs).to.be.within(PAUSE_MS - ELAPSED_TOLERANCE_MS, PAUSE_MS);
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

        let processing: number;
        let pushed: number | undefined;

        beforeEach(async function () {
            processing = await store.push(message(CHAT, "processing", 1));
            pushed = undefined;
            await store.pull(10);
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
            expect((await store.pull(10)).messages.map(({ id }) => id)).to.deep.equal([pushed]);
        });

        it("leaves the chat ready with the new head when the completion locks the chat first", async function () {
            await race(complete, push);

            expect(await chat(CHAT)).to.deep.equal({ state: OutboxChatState.Ready });
            expect((await store.pull(10)).messages.map(({ id }) => id)).to.deep.equal([pushed]);
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
            const payloads = await listen(listener, OutboxChannel.Ready);

            await store.pushBatch([message(CHAT, "first"), message(OTHER_CHAT, "second")]);

            await waitUntil(() => payloads.length > 0, "no ready notification came");
            expect(payloads).to.deep.equal([""]);
        });

        it("notifies the finished channel with the id of a message marked as done", async function () {
            const payloads = await listen(listener, OutboxChannel.Finished);
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            await store.markAsDone(id, RESPONSE);

            await waitUntil(() => payloads.length > 0, "no finished notification came");
            expect(payloads).to.deep.equal([String(id)]);
        });

        it("hands the id of a finished message to the listener and tells it the listening started", async function () {
            const finishedIds: number[] = [];
            let listenCount = 0;
            await new OutboxStore(listener, NO_LIMITS).listenForFinished(
                (messageId) => finishedIds.push(messageId),
                () => (listenCount += 1),
            );
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            await store.markAsDone(id, RESPONSE);

            await waitUntil(() => finishedIds.length > 0, "no finished message came");
            expect(finishedIds).to.deep.equal([id]);
            expect(listenCount).to.equal(1);
        });

        it("ends the listening with close() of the database", async function () {
            await listen(listener, OutboxChannel.Finished);
            await waitForListeners(1);

            await listener.close();

            await waitForListeners(0);
        });
    });

    it("finds the finished messages among the ids given", async function () {
        const done = await store.push(message(CHAT, "done"));
        const failed = await store.push(message(CHAT, "failed"));
        const skipped = await store.push(message(CHAT, "skipped"));
        const pending = await store.push(message(CHAT, "pending"));
        const notAsked = await store.push(message(CHAT, "not asked"));
        // Nothing but markAsDone writes a final status yet, and it takes a pulled head.
        await setStatus(done, OutboxStatus.Done, RESPONSE);
        await setStatus(failed, OutboxStatus.Failed, null);
        await setStatus(skipped, OutboxStatus.Skipped, null);
        await setStatus(notAsked, OutboxStatus.Done, RESPONSE);

        const finished = await store.findFinished([done, failed, skipped, pending]);

        expect([...finished].sort((a, b) => a.id - b.id)).to.deep.equal([
            { id: done, status: OutboxStatus.Done, response: RESPONSE },
            { id: failed, status: OutboxStatus.Failed, response: null },
            { id: skipped, status: OutboxStatus.Skipped, response: null },
        ]);
    });

    it("finds no finished message for no ids", async function () {
        expect(await store.findFinished([])).to.deep.equal([]);
    });

    describe("OutboxResultWaiter on the database", function () {
        // The waiter listens through a client of its own, closed at the end of the test.
        let waiterDatabase: Database;
        let source: RecordingSource;

        beforeEach(function () {
            waiterDatabase = new Database(settings, false);
            source = new RecordingSource(new OutboxStore(waiterDatabase, NO_LIMITS));
        });

        afterEach(async function () {
            await waiterDatabase.close();
        });

        // A poll that never comes in a passing test: only a notification can settle the wait.
        const NO_POLL: OutboxResultWaiterSettings = { timeoutMs: WAIT_DEADLINE_MS, pollIntervalMs: SPEC_TIMEOUT_MS };

        it("settles a wait by the notification of markAsDone", async function () {
            const waiter = new OutboxResultWaiter(source, silentLogger(), NO_POLL);
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            const result = waiter.wait(id);
            // The poll made when the listening started has found nothing: what settles the wait
            // from here on is the notification.
            await waitUntil(() => source.completedLookups === 1, "the listening did not start");
            await store.markAsDone(id, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });

        it("settles a wait by the poll when the message finishes without a notification", async function () {
            const waiter = new OutboxResultWaiter(source, silentLogger(), { timeoutMs: WAIT_DEADLINE_MS, pollIntervalMs: FAST_POLL_MS });
            const id = await store.push(message(CHAT, "first"));

            const result = waiter.wait(id);
            await setStatus(id, OutboxStatus.Done, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });

        it("rejects a wait on timeout and does not read its message when it finishes", async function () {
            const waiter = new OutboxResultWaiter(source, silentLogger(), {
                timeoutMs: SHORT_WAIT_TIMEOUT_MS,
                pollIntervalMs: SPEC_TIMEOUT_MS,
            });
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            const error = await waiter.wait(id).then(
                () => expect.fail("the wait was expected to time out"),
                (reason: unknown) => reason,
            );
            // A notification sent before the listening starts would go nowhere.
            await waitUntil(() => source.listenCount === 1, "the listening did not start");
            const lookupCount = source.startedLookups;
            await store.markAsDone(id, RESPONSE);
            await waitUntil(() => source.notifiedIds.includes(id), "no finished notification came");

            expect(error).to.be.instanceOf(OutboxResultTimeout);
            expect(source.startedLookups).to.equal(lookupCount);
        });

        // postgres.js listens again on a new connection; the poll it triggers catches a message
        // finished in between, whose notification went nowhere.
        it("listens again after its connection is lost", async function () {
            const waiter = new OutboxResultWaiter(source, silentLogger(), NO_POLL);
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            const result = waiter.wait(id);
            await waitUntil(() => source.completedLookups === 1, "the listening did not start");
            await observer.sql`
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND query = ${LISTEN_FINISHED_QUERY}
            `;
            await waitUntil(() => source.listenCount === 2, "the listening did not start again");
            await waitUntil(() => source.completedLookups === 2, "no poll followed the new listening");
            await store.markAsDone(id, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });
    });

    // A store whose statements run in the given transaction.
    function storeOn(transaction: TransactionSql): OutboxStore {
        return new OutboxStore({ sql: transaction } as unknown as Database, NO_LIMITS);
    }

    async function chat(chatId: number): Promise<ChatRow | undefined> {
        const [row] = await database.sql<ChatRow[]>`
            SELECT state
            FROM telegram_outbox_chats
            WHERE chat_id = ${chatId}
        `;

        return row;
    }

    async function expectNotProcessing(messageId: number): Promise<void> {
        const error = await store.markAsDone(messageId, RESPONSE).then(
            () => expect.fail("markAsDone() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(OutboxMessageNotProcessing);
        expect((error as OutboxMessageNotProcessing).payload).to.deep.equal({ messageId });
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_outbox ORDER BY id`;

        return rows.map((row) => row.status);
    }

    async function setStatus(messageId: number, status: OutboxStatus, response: typeof RESPONSE | null): Promise<void> {
        await database.sql`
            UPDATE telegram_outbox
            SET status = ${status},
                response = ${response === null ? null : database.sql.json(response)}
            WHERE id = ${messageId}
        `;
    }

    // The LISTEN connections of the finished channel open in the database of the run.
    async function waitForListeners(count: number): Promise<void> {
        const deadline = Date.now() + WAIT_DEADLINE_MS;

        for (;;) {
            if (Date.now() > deadline) {
                expect.fail(`the finished channel did not get to ${count} listeners by the deadline`);
            }

            const [row] = await observer.sql<{ listeners: number }[]>`
                SELECT count(*)::int AS listeners
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND query = ${LISTEN_FINISHED_QUERY}
            `;

            if (row !== undefined && row.listeners === count) {
                return;
            }

            await sleep(5);
        }
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
        const [pulled] = (await store.pull(1)).messages;

        if (pulled === undefined) {
            return ids;
        }

        ids.push(pulled.id);
        await store.markAsDone(pulled.id, RESPONSE);
    }
}

// The statement postgres.js sends to listen on the finished channel, as pg_stat_activity shows it.
const LISTEN_FINISHED_QUERY = `listen "${OutboxChannel.Finished}"`;

// The payloads of the notifications of a channel, from the moment the listening starts.
async function listen(database: Database, channel: OutboxChannel): Promise<string[]> {
    const payloads: string[] = [];
    await database.sql.listen(channel, (payload) => payloads.push(payload));

    return payloads;
}

async function waitUntil(condition: () => boolean, failure: string): Promise<void> {
    const deadline = Date.now() + WAIT_DEADLINE_MS;

    while (!condition()) {
        if (Date.now() > deadline) {
            expect.fail(failure);
        }

        await sleep(5);
    }
}

// The real store with a record of what the waiter does with it.
class RecordingSource implements FinishedMessageSource {
    public startedLookups = 0;
    public completedLookups = 0;
    public listenCount = 0;
    public readonly notifiedIds: number[] = [];

    public constructor(private readonly store: OutboxStore) {}

    public async findFinished(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        this.startedLookups += 1;
        const finished = await this.store.findFinished(messageIds);
        this.completedLookups += 1;

        return finished;
    }

    public listenForFinished(onFinished: (messageId: number) => void, onListen: () => void): Promise<void> {
        return this.store.listenForFinished(
            (messageId) => {
                this.notifiedIds.push(messageId);
                onFinished(messageId);
            },
            () => {
                this.listenCount += 1;
                onListen();
            },
        );
    }
}

function silentLogger(): Logger {
    const ignore = (): void => {};

    return { critical: ignore, error: ignore, warning: ignore, info: ignore, debug: ignore };
}
