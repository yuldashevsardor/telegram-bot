import "reflect-metadata";
import { expect } from "chai";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { Database } from "app/platform/database/database";
import { sleep } from "app/shared/utils";
import { MS_PER_SECOND } from "app/shared/time";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import type { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { OutboxWorkerLoop } from "app/telegram/outbox/outbox-worker-loop";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxCleanupSettings, OutboxJson, OutboxMessageInput, OutboxWorker } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { testDatabaseSettings } from "test/database.helper";
import type { Logger } from "app/platform/logger/logger";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const CHATS = [5_000_000_001, 5_000_000_002, 5_000_000_003, 5_000_000_004, 5_000_000_005];
const MESSAGES_PER_CHAT = 20;
const MESSAGE_COUNT = CHATS.length * MESSAGES_PER_CHAT;
// Two slots per node, four in all, fewer than the chats: each node always has a chat to pull.
const CONCURRENCY = 2;
const LONG_STOP_TIMEOUT_MS = 10_000;
const LEASE_DURATION_MS = 60_000;
// A cooldown of a nanosecond, below the microsecond of a timestamp, and a common limit no pull
// reaches: the spec is about the order, not the limits.
const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };
const HOUR_MS = 60 * 60 * MS_PER_SECOND;
const CLEANUP: OutboxCleanupSettings = { doneRetentionMs: HOUR_MS, skippedRetentionMs: HOUR_MS, batchSize: 10 };
// The longest a fake call takes: long enough for the calls of two nodes to overlap.
const MAX_CALL_MS = 5;
// The sends take well under a second with the shortest sleep cap of the source.
const SEND_DEADLINE_MS = 20_000;
const SPEC_TIMEOUT_MS = 30_000;
// How often the spec counts the done messages while the loops send.
const DONE_POLL_INTERVAL_MS = 20;

type Send = { chatId: number; index: number; host: string };

// Records the calls of both nodes in the order they start, and answers after a random delay.
class RecordingSender {
    public constructor(private readonly sends: Send[], private readonly host: string) {}

    public async send(_method: string, payload: Record<string, unknown>): Promise<OutboxJson> {
        this.sends.push({ chatId: Number(payload["chat_id"]), index: Number(payload["index"]), host: this.host });
        await sleep(Math.random() * MAX_CALL_MS);

        return { message_id: 1 };
    }
}

// A failure of a fake call is a bug of the spec: the failure handler only records it.
class RecordingFailureHandler {
    public readonly failures: unknown[] = [];

    public async handle(_message: unknown, error: unknown): Promise<void> {
        this.failures.push(error);
    }

    public async releaseOnStop(): Promise<void> {
        this.failures.push("released on stop");
    }
}

describe("OutboxWorkerLoop on the database", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    // A client per node.
    let firstDatabase: Database;
    let secondDatabase: Database;

    before(async function () {
        const settings = await testDatabaseSettings();

        firstDatabase = new Database(settings, false);
        secondDatabase = new Database(settings, false);
    });

    beforeEach(async function () {
        await firstDatabase.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
        await firstDatabase.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
        `;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await firstDatabase?.close();
        await secondDatabase?.close();
    });

    it("sends the messages of every chat in order across two nodes", async function () {
        const sends: Send[] = [];
        const logger = new RecordingLogger();
        const failureHandler = new RecordingFailureHandler();
        const firstNode = createNode(firstDatabase, "node-1", sends, failureHandler, logger);
        const secondNode = createNode(secondDatabase, "node-2", sends, failureHandler, logger);
        await firstNode.store.pushBatch(messages());

        firstNode.loop.start();
        secondNode.loop.start();

        try {
            await waitForDone(firstDatabase);
        } finally {
            await firstNode.loop.stop();
            await secondNode.loop.stop();
        }

        expect(failureHandler.failures).to.deep.equal([]);
        expect([...logger.criticals, ...logger.errors, ...logger.warnings]).to.deep.equal([]);
        expect(sends).to.have.lengthOf(MESSAGE_COUNT);
        for (const chatId of CHATS) {
            const indexes = sends.filter((send) => send.chatId === chatId).map((send) => send.index);

            expect(indexes, `the sends of chat ${chatId}`).to.deep.equal([...Array(MESSAGES_PER_CHAT).keys()]);
        }
        expect(new Set(sends.map((send) => send.host))).to.deep.equal(new Set(["node-1", "node-2"]));
    });
});

function createNode(
    database: Database,
    host: string,
    sends: Send[],
    failureHandler: RecordingFailureHandler,
    logger: Logger,
): { store: OutboxStore; loop: OutboxWorkerLoop } {
    const store = new OutboxStore(database, logger, NO_LIMITS, LEASE_DURATION_MS, CLEANUP);
    // The shortest sleep cap: a pull that finds nothing ready waits 100 ms, not up to a second.
    const source = new OutboxMessageSource(store, logger, () => 0);
    const processor = new OutboxMessageProcessor(
        new RecordingSender(sends, host) as unknown as OutboxSender,
        store,
        failureHandler as unknown as OutboxFailureHandler,
        logger,
    );
    const worker: OutboxWorker = { host, pid: 1, workerId: `${host}-loop` };
    const loop = new OutboxWorkerLoop(source, processor, logger, CONCURRENCY, LONG_STOP_TIMEOUT_MS, worker);

    return { store, loop };
}

// The messages of every chat, interleaved across the chats in the order of the ids.
function messages(): OutboxMessageInput[] {
    const inputs: OutboxMessageInput[] = [];

    for (let index = 0; index < MESSAGES_PER_CHAT; index += 1) {
        for (const chatId of CHATS) {
            inputs.push({ chatId, method: "sendMessage", payload: { chat_id: chatId, index }, priority: 0 });
        }
    }

    return inputs;
}

async function waitForDone(database: Database): Promise<void> {
    const deadline = Date.now() + SEND_DEADLINE_MS;

    while (Date.now() <= deadline) {
        const [row] = await database.sql<{ count: string }[]>`
            SELECT count(*) AS count
            FROM telegram_outbox
            WHERE status = ${OutboxStatus.Done}
        `;

        if (Number(row?.count) === MESSAGE_COUNT) {
            return;
        }

        await sleep(DONE_POLL_INTERVAL_MS);
    }

    expect.fail(`the ${MESSAGE_COUNT} messages were expected to be done`);
}
