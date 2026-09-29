import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { Database } from "app/platform/database/database";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { Logger } from "app/platform/logger/logger";
import { sleep } from "app/shared/utils";
import { OutboxFinishedMessageReader } from "app/telegram/outbox/outbox-finished-message-reader";
import { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import { OutboxResultTimeout } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import type { OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { FinishedOutboxMessage, OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChannel, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { testDatabaseSettings } from "test/database.helper";
import { NOTIFICATION_DEADLINE_MS, waitUntil } from "test/telegram/outbox/outbox-store.helper";

const CHAT = 5_000_000_001;
const RESPONSE = { message_id: 1 };
// The default timeout of mocha, 2 s, is shorter than the deadline of a wait and would fail a hung
// wait first.
const SPEC_TIMEOUT_MS = 10_000;
// The store only makes the messages here: no limit holds a pull back.
const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };
// The poll of the waiter specs that rely on it: many polls within a test.
const FAST_POLL_MS = 20;
// The timeout of the waiter spec that times out: over long before NOTIFICATION_DEADLINE_MS.
const SHORT_WAIT_TIMEOUT_MS = 50;
// The statement postgres.js sends to listen on the finished channel, as pg_stat_activity shows it.
const LISTEN_FINISHED_QUERY = `listen "${OutboxChannel.Finished}"`;

describe("OutboxFinishedMessageReader", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let settings: DatabaseSettings;
    let database: Database;
    // The client of waitForListeners(), apart from the pools it counts.
    let observer: Database;
    let store: OutboxStore;
    let reader: OutboxFinishedMessageReader;

    before(async function () {
        settings = await testDatabaseSettings();

        database = new Database(settings, false);
        observer = new Database(settings, false);
        store = new OutboxStore(database, NO_LIMITS);
        reader = new OutboxFinishedMessageReader(database);
    });

    beforeEach(async function () {
        await database.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
        await database.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
        `;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await database?.close();
        await observer?.close();
    });

    describe("listening", function () {
        // A client of its own per test: closed at the end, it takes its LISTEN connection along, so
        // the next test counts only its own.
        let listener: Database;

        beforeEach(function () {
            listener = new Database(settings, false);
        });

        afterEach(async function () {
            await listener.close();
        });

        it("hands the id of a finished message to the listener and tells it the listening started", async function () {
            const finishedIds: number[] = [];
            let listenCount = 0;
            await new OutboxFinishedMessageReader(listener).listen(
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
            await new OutboxFinishedMessageReader(listener).listen(
                () => {},
                () => {},
            );
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

        const finished = await reader.find([done, failed, skipped, pending]);

        expect([...finished].sort((a, b) => a.id - b.id)).to.deep.equal([
            { id: done, status: OutboxStatus.Done, response: RESPONSE },
            { id: failed, status: OutboxStatus.Failed, response: null },
            { id: skipped, status: OutboxStatus.Skipped, response: null },
        ]);
    });

    it("finds no finished message for no ids", async function () {
        expect(await reader.find([])).to.deep.equal([]);
    });

    describe("OutboxResultWaiter on the database", function () {
        // The waiter listens through a client of its own, closed at the end of the test.
        let waiterDatabase: Database;
        let recordingReader: RecordingReader;

        beforeEach(function () {
            waiterDatabase = new Database(settings, false);
            recordingReader = new RecordingReader(waiterDatabase);
        });

        afterEach(async function () {
            await waiterDatabase.close();
        });

        // A poll that never comes in a passing test: only a notification can settle the wait.
        const NO_POLL: OutboxResultWaiterSettings = { timeoutMs: NOTIFICATION_DEADLINE_MS, pollIntervalMs: SPEC_TIMEOUT_MS };

        it("settles a wait by the notification of markAsDone", async function () {
            const waiter = new OutboxResultWaiter(recordingReader, silentLogger(), NO_POLL);
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            const result = waiter.wait(id);
            // The poll made when the listening started has found nothing: what settles the wait
            // from here on is the notification.
            await waitUntil(() => recordingReader.completedLookups === 1, "the listening did not start");
            await store.markAsDone(id, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });

        it("settles a wait by the poll when the message finishes without a notification", async function () {
            const waiter = new OutboxResultWaiter(recordingReader, silentLogger(), {
                timeoutMs: NOTIFICATION_DEADLINE_MS,
                pollIntervalMs: FAST_POLL_MS,
            });
            const id = await store.push(message(CHAT, "first"));

            const result = waiter.wait(id);
            await setStatus(id, OutboxStatus.Done, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });

        it("rejects a wait on timeout and does not read its message when it finishes", async function () {
            const waiter = new OutboxResultWaiter(recordingReader, silentLogger(), {
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
            await waitUntil(() => recordingReader.listenCount === 1, "the listening did not start");
            const lookupCount = recordingReader.startedLookups;
            await store.markAsDone(id, RESPONSE);
            await waitUntil(() => recordingReader.notifiedIds.includes(id), "no finished notification came");

            expect(error).to.be.instanceOf(OutboxResultTimeout);
            expect(recordingReader.startedLookups).to.equal(lookupCount);
        });

        // postgres.js listens again on a new connection; the poll it triggers catches a message
        // finished in between, whose notification went nowhere.
        it("listens again after its connection is lost", async function () {
            const waiter = new OutboxResultWaiter(recordingReader, silentLogger(), NO_POLL);
            const id = await store.push(message(CHAT, "first"));
            await store.pull(10);

            const result = waiter.wait(id);
            await waitUntil(() => recordingReader.completedLookups === 1, "the listening did not start");
            await observer.sql`
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND query = ${LISTEN_FINISHED_QUERY}
            `;
            await waitUntil(() => recordingReader.listenCount === 2, "the listening did not start again");
            await waitUntil(() => recordingReader.completedLookups === 2, "no poll followed the new listening");
            await store.markAsDone(id, RESPONSE);

            expect(await result).to.deep.equal({ id: id, status: OutboxStatus.Done, response: RESPONSE });
        });
    });

    // A store whose statements run in the given transaction.

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
        const deadline = Date.now() + NOTIFICATION_DEADLINE_MS;

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
});

function message(chatId: number, text: string, priority = 0): OutboxMessageInput {
    return { chatId, method: "sendMessage", payload: { chat_id: chatId, text }, priority };
}

// The real reader with a record of what the waiter does with it.
class RecordingReader extends OutboxFinishedMessageReader {
    public startedLookups = 0;
    public completedLookups = 0;
    public listenCount = 0;
    public readonly notifiedIds: number[] = [];

    public override async find(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        this.startedLookups += 1;
        const finished = await super.find(messageIds);
        this.completedLookups += 1;

        return finished;
    }

    public override listen(onFinished: (messageId: number) => void, onListen: () => void): Promise<void> {
        return super.listen(
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
