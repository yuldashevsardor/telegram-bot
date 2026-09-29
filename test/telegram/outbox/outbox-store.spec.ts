import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { Database } from "app/platform/database/database";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxMessageNotProcessing } from "app/telegram/outbox/store/outbox-store.errors";
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

    before(async function () {
        const settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
        observer = new Database(settings, false);
        store = new OutboxStore(database, NO_LIMITS);
    });

    beforeEach(async function () {
        await database.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
        // The common limit has saved up its full number of slots, and there is no pause.
        await database.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
            WHERE id = 1
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

    // The chats of one pull get the same next_attempt_at, the time of the statement. Without the
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
        const COMMON_LIMITS: TelegramLimits = { ...NO_LIMITS, common: { number: 3, interval: COMMON_INTERVAL_MS } };
        const PAUSE_MS = 60_000;

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
                SELECT chat_id, extract(epoch FROM next_attempt_at - updated_at)::double precision * 1000 AS moved_ms
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

            await limited.pushBatch([1, 2, 3, 4, 5].map((chatId) => message(chatId, "text")));

            expect((await limited.pull(10)).messages).to.have.lengthOf(3);

            const spent = await limited.pull(10);

            expect(spent.messages).to.deep.equal([]);
            expect(spent.nextPullInMs).to.be.within(COMMON_INTERVAL_MS - COMMON_COOLDOWN_MS, COMMON_INTERVAL_MS);
        });

        // Slots saved up and spent at once must not come due again inside the same interval: after a
        // burst of the whole limit a slot a cooldown later would put number + 1 messages in it.
        it("holds the next message back a cooldown per message of the batch, from the pull", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch([1, 2, 3, 4, 5].map((chatId) => message(chatId, "text")));
            await limited.pull(10);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_INTERVAL_MS);

            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now()`;
            await limited.pull(10);

            expect(await nextSendAfterUpdateMs()).to.equal(COMMON_COOLDOWN_MS);
        });

        it("gives out only the slots of the common limit that have come due", async function () {
            const limited = new OutboxStore(database, COMMON_LIMITS);

            await limited.pushBatch([1, 2, 3, 4, 5].map((chatId) => message(chatId, "text")));
            // Two slots have come due: at next_send_at and a cooldown later.
            await database.sql`UPDATE telegram_bot_limits SET next_send_at = now() - ${
                COMMON_COOLDOWN_MS * 1.5
            }::double precision * interval '1 millisecond'`;

            expect((await limited.pull(10)).messages).to.have.lengthOf(2);
        });

        it("stops the pull on every client while the pause lasts", async function () {
            await store.push(message(CHAT, "text"));
            await store.pause(PAUSE_MS);

            const paused = await new OutboxStore(other, NO_LIMITS).pull(10);

            expect(paused.messages).to.deep.equal([]);
            expect(paused.nextPullInMs).to.be.within(PAUSE_MS - 1_000, PAUSE_MS);
            expect((await store.pull(10)).messages).to.deep.equal([]);
        });

        it("lets the pull through once the pause is over", async function () {
            const id = await store.push(message(CHAT, "text"));

            await store.pause(1);
            await sleep(10);

            expect((await store.pull(10)).messages.map((pulled) => pulled.id)).to.deep.equal([id]);
        });

        it("never shortens a pause, only lengthens it", async function () {
            await store.pause(PAUSE_MS);
            const paused = await pausedUntil();

            await store.pause(1_000);
            expect(await pausedUntil()).to.deep.equal(paused);

            await store.pause(2 * PAUSE_MS);
            expect((await pausedUntil()).getTime()).to.be.greaterThan(paused.getTime());
        });

        it("reports no next pull when no chat is ready", async function () {
            expect(await store.pull(10)).to.deep.equal({ messages: [], nextPullInMs: null });

            await store.push(message(CHAT, "text"));

            expect((await store.pull(10)).nextPullInMs).to.equal(null);
        });

        it("reports the next pull at once when a ready chat was left out by the limit of the pull", async function () {
            await store.pushBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

            expect((await store.pull(1)).nextPullInMs).to.equal(0);
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

            expect((await limited.pull(10)).nextPullInMs).to.be.within(PAUSE_MS - 1_000, PAUSE_MS);
        });

        // Both columns are now() of the last pull that took messages.
        async function nextSendAfterUpdateMs(): Promise<number> {
            const [row] = await database.sql<{ moved_ms: number }[]>`
                SELECT extract(epoch FROM next_send_at - updated_at)::double precision * 1000 AS moved_ms
                FROM telegram_bot_limits
            `;

            return (row as { moved_ms: number }).moved_ms;
        }

        async function pausedUntil(): Promise<Date> {
            const [row] = await database.sql<{ paused_until: Date }[]>`SELECT paused_until FROM telegram_bot_limits`;

            return (row as { paused_until: Date }).paused_until;
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
