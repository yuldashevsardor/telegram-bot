import "reflect-metadata";
import { expect } from "chai";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { Database } from "app/platform/database/database";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { sleep } from "app/shared/utils";
import { testDatabaseName } from "test/database.helper";

const CHAT = 5_000_000_001;
const OTHER_CHAT = -1_001_234_567_890;
const RESPONSE = { message_id: 1 };
// Longer than any wait of a passing run, shorter than the timeout of mocha: a hung wait fails with
// its own message and stops before after() closes the clients.
const WAIT_DEADLINE_MS = 5_000;

type ChatRow = { state: string; head_priority: number | null };

describe("OutboxStore", function () {
    let settings: DatabaseSettings;
    let database: Database;
    // A second postgres() client: a claimer on another node, or a transaction held open.
    let other: Database;
    let store: OutboxStore;

    before(async function () {
        const env = await new ConfigEnvStorage().load();
        // The config requires BOT_TOKEN while the spec needs only the database: without
        // the substitution it would depend on the token in .env.
        settings = { ...new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database, database: testDatabaseName() };

        database = new Database(settings, false);
        other = new Database(settings, false);
        store = new OutboxStore(database);
    });

    beforeEach(async function () {
        await database.sql`truncate telegram_outbox, telegram_outbox_chats restart identity`;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await database?.close();
        await other?.close();
    });

    it("keeps the single row of the bot limits", async function () {
        const rows = await database.sql`select paused_until from telegram_bot_limits`;

        expect([...rows]).to.deep.equal([{ paused_until: null }]);
    });

    it("gives out the messages of a chat in id order", async function () {
        const ids = [
            await store.enqueue(message(CHAT, "first")),
            ...(await store.enqueueBatch([message(CHAT, "second"), message(CHAT, "third")])),
        ];

        expect(await drain(store)).to.deep.equal(ids);
        expect(await chat(CHAT)).to.deep.equal({ state: "idle", head_priority: null });
    });

    it("returns the ids of a batch in the order of the input across chats", async function () {
        const ids = await store.enqueueBatch([message(CHAT, "a"), message(OTHER_CHAT, "b"), message(CHAT, "c")]);
        const rows = await database.sql<{ id: string; text: string }[]>`
            select id, payload ->> 'text' as text
            from telegram_outbox
            order by id
        `;

        expect(rows.map((row) => [Number(row.id), row.text])).to.deep.equal([
            [ids[0], "a"],
            [ids[1], "b"],
            [ids[2], "c"],
        ]);
    });

    it("keeps the method, the payload and the priority of a claimed message", async function () {
        const id = await store.enqueue({
            chatId: OTHER_CHAT,
            method: "sendPhoto",
            payload: { photo: "file-id", caption: null },
            priority: 3,
        });

        expect(await store.claim(10)).to.deep.equal([
            { id, chatId: OTHER_CHAT, method: "sendPhoto", payload: { photo: "file-id", caption: null }, priority: 3 },
        ]);
    });

    it("never keeps two messages of a chat in processing", async function () {
        await store.enqueueBatch([message(CHAT, "first"), message(CHAT, "second"), message(CHAT, "third")]);

        expect(await store.claim(10)).to.have.lengthOf(1);
        expect(await store.claim(10)).to.deep.equal([]);
        expect(await statuses()).to.deep.equal(["processing", "pending", "pending"]);
        expect(await chat(CHAT)).to.deep.equal({ state: "processing", head_priority: 0 });
    });

    it("serves the chats in turn, not one chat drained first", async function () {
        const first = await store.enqueueBatch([message(CHAT, "1"), message(CHAT, "2"), message(CHAT, "3")]);
        const second = await store.enqueueBatch([message(OTHER_CHAT, "1"), message(OTHER_CHAT, "2"), message(OTHER_CHAT, "3")]);

        expect(await drain(store)).to.deep.equal([first[0], second[0], first[1], second[1], first[2], second[2]]);
    });

    it("takes one head from each of several ready chats in one claim", async function () {
        const [a] = await store.enqueueBatch([message(CHAT, "a1"), message(CHAT, "a2")]);
        const [b] = await store.enqueueBatch([message(OTHER_CHAT, "b1"), message(OTHER_CHAT, "b2")]);

        expect((await store.claim(10)).map(({ id }) => id)).to.deep.equal([a, b]);
    });

    it("claims no more chats than the limit", async function () {
        await store.enqueueBatch([message(CHAT, "a"), message(OTHER_CHAT, "b")]);

        expect(await store.claim(1)).to.have.lengthOf(1);
    });

    it("sets head_priority to the head, not to the latest message", async function () {
        await store.enqueueBatch([message(CHAT, "first", 2), message(CHAT, "second", 0)]);

        expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 2 });

        await store.enqueue(message(CHAT, "third", 1));

        expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 2 });

        const [claimed] = await store.claim(10);

        expect(await store.markDone(claimed!.id, RESPONSE)).to.equal(true);
        expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 0 });
    });

    it("stores the response and the end of a done message", async function () {
        const id = await store.enqueue(message(CHAT, "text"));

        await store.claim(10);
        await store.markDone(id, RESPONSE);

        const [row] = await database.sql<{ status: string; response: unknown; finished: boolean }[]>`
            select status, response, finished_at is not null as finished
            from telegram_outbox
            where id = ${id}
        `;

        expect(row).to.deep.equal({ status: "done", response: RESPONSE, finished: true });
    });

    it("refuses to mark done a message that is not processing and changes nothing", async function () {
        const id = await store.enqueue(message(CHAT, "text"));

        expect(await store.markDone(id, RESPONSE)).to.equal(false);
        expect(await statuses()).to.deep.equal(["pending"]);
        expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 0 });

        await store.claim(10);
        await store.markDone(id, RESPONSE);

        expect(await store.markDone(id, RESPONSE)).to.equal(false);
        expect(await store.markDone(id + 1, RESPONSE)).to.equal(false);
    });

    it("takes a chat with a higher-priority head first", async function () {
        await store.enqueue(message(CHAT, "later", 2));
        const urgent = await store.enqueue(message(OTHER_CHAT, "urgent", 0));

        expect((await store.claim(1)).map(({ id }) => id)).to.deep.equal([urgent]);
    });

    // An id taken before the chat lock would let two overlapping enqueues of one chat commit in the
    // order opposite to their ids, and the later id would be sent first. The enqueue of another chat
    // stands in for the one that commits first.
    it("takes the ids of an enqueue only once its chat is locked", async function () {
        await store.enqueue(message(CHAT, "first"));

        let waiting: Promise<number> = Promise.resolve(0);
        let passing = 0;

        await other.sql.begin(async (sql) => {
            await sql`select chat_id from telegram_outbox_chats where chat_id = ${CHAT} for update`;

            waiting = store.enqueue(message(CHAT, "waiting"));

            await waitForLockWaiters(1);

            passing = await store.enqueue(message(OTHER_CHAT, "passing"));
        });

        expect(await waiting).to.be.greaterThan(passing);
    });

    it("skips a chat another claimer holds and takes the next one", async function () {
        await store.enqueue(message(CHAT, "held"));
        const free = await store.enqueue(message(OTHER_CHAT, "free"));

        await other.sql.begin(async (sql) => {
            await sql`select chat_id from telegram_outbox_chats where chat_id = ${CHAT} for update`;

            expect((await store.claim(10)).map(({ id }) => id)).to.deep.equal([free]);
        });
    });

    it("never gives one message or two heads of a chat to two claimers on separate clients", async function () {
        this.timeout(20_000);

        const chats = [CHAT, OTHER_CHAT, 1, 2, 3, 4];
        const perChat = 8;
        const ids = await store.enqueueBatch(
            Array.from({ length: perChat }, (_, index) => chats.map((chatId) => message(chatId, String(index)))).flat(),
        );
        const claims: number[] = [];
        const claimsByChat = new Map<number, number[]>();
        const inFlight = new Set<number>();

        const deadline = Date.now() + WAIT_DEADLINE_MS;
        let failed = false;

        // A chat leaves inFlight before markDone commits: the chat becomes claimable only after the
        // commit, so an overlap seen here is a real one.
        const claim = async (client: OutboxStore): Promise<void> => {
            while (!failed && claims.length < ids.length) {
                if (Date.now() > deadline) {
                    expect.fail(`${claims.length} of ${ids.length} messages claimed by the deadline`);
                }

                const batch = await client.claim(2);

                if (batch.length === 0) {
                    await sleep(1);
                    continue;
                }

                for (const claimed of batch) {
                    expect(inFlight.has(claimed.chatId), `chat ${claimed.chatId} is claimed twice`).to.equal(false);
                    inFlight.add(claimed.chatId);
                    claims.push(claimed.id);
                    claimsByChat.set(claimed.chatId, [...(claimsByChat.get(claimed.chatId) ?? []), claimed.id]);
                }

                for (const claimed of batch) {
                    await sleep(Math.random() * 3);
                    inFlight.delete(claimed.chatId);
                    expect(await client.markDone(claimed.id, RESPONSE)).to.equal(true);
                }
            }
        };

        // A failed claimer stops the other one, which would otherwise keep going after the test.
        const claimer = (client: OutboxStore): Promise<void> =>
            claim(client).catch((error: unknown) => {
                failed = true;
                throw error;
            });

        await Promise.all([claimer(store), claimer(new OutboxStore(other))]);

        expect([...claims].sort((a, b) => a - b)).to.deep.equal(ids);

        for (const [chatId, chatClaims] of claimsByChat) {
            expect(chatClaims, `chat ${chatId}`).to.deep.equal([...chatClaims].sort((a, b) => a - b));
        }
    });

    describe("a concurrent enqueue and completion", function () {
        // The third client holds the chat row, the store calls queue up behind it in a known order,
        // and the order decides which of them sees the other.
        async function race(first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> {
            let calls: Promise<unknown> = Promise.resolve();

            // The transaction commits on return and lets the waiting calls through.
            await other.sql.begin(async (sql) => {
                await sql`select chat_id from telegram_outbox_chats where chat_id = ${CHAT} for update`;

                const firstCall = first();

                await waitForLockWaiters(1);

                calls = Promise.all([firstCall, second()]);

                await waitForLockWaiters(2);
            });

            await calls;
        }

        let processing: number;
        let enqueued: number | undefined;

        beforeEach(async function () {
            processing = await store.enqueue(message(CHAT, "processing", 1));
            enqueued = undefined;
            await store.claim(10);
        });

        const enqueue = async (): Promise<void> => {
            enqueued = await store.enqueue(message(CHAT, "enqueued", 4));
        };
        const complete = async (): Promise<void> => {
            expect(await store.markDone(processing, RESPONSE)).to.equal(true);
        };

        it("leaves the chat ready with the new head when the enqueue locks the chat first", async function () {
            await race(enqueue, complete);

            expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 4 });
            expect((await store.claim(10)).map(({ id }) => id)).to.deep.equal([enqueued]);
        });

        it("leaves the chat ready with the new head when the completion locks the chat first", async function () {
            await race(complete, enqueue);

            expect(await chat(CHAT)).to.deep.equal({ state: "ready", head_priority: 4 });
            expect((await store.claim(10)).map(({ id }) => id)).to.deep.equal([enqueued]);
        });
    });

    async function chat(chatId: number): Promise<ChatRow | undefined> {
        const [row] = await database.sql<ChatRow[]>`
            select state, head_priority
            from telegram_outbox_chats
            where chat_id = ${chatId}
        `;

        return row;
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`select status from telegram_outbox order by id`;

        return rows.map((row) => row.status);
    }

    async function waitForLockWaiters(count: number): Promise<void> {
        const deadline = Date.now() + WAIT_DEADLINE_MS;

        for (;;) {
            if (Date.now() > deadline) {
                expect.fail(`fewer than ${count} queries waited for a lock by the deadline`);
            }

            const [row] = await database.sql<{ waiting: number }[]>`
                select count(*)::int as waiting
                from pg_stat_activity
                where datname = current_database()
                  and wait_event_type = 'Lock'
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

// Claims one message at a time and marks it done until the outbox is empty; the ids in claim order.
async function drain(store: OutboxStore): Promise<number[]> {
    const ids: number[] = [];

    for (;;) {
        const [claimed] = await store.claim(1);

        if (claimed === undefined) {
            return ids;
        }

        ids.push(claimed.id);
        await store.markDone(claimed.id, RESPONSE);
    }
}
