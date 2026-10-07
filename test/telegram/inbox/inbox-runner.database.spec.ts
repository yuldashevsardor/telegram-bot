import "reflect-metadata";
import { expect } from "chai";
import { BotError } from "grammy";
import type { Update } from "@grammyjs/types";
import { Database } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { MS_PER_DAY } from "app/shared/time";
import { sleep } from "app/shared/utils";
import type { Bot } from "app/telegram/bot/bot";
import type { Context } from "app/telegram/bot/bot.types";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { InboxFailureClassifier } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier";
import { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import { InboxRunner } from "app/telegram/inbox/inbox-runner";
import { InboxUpdateProcessor } from "app/telegram/inbox/inbox-update-processor";
import { InboxUpdateSource } from "app/telegram/inbox/inbox-update-source";
import { InboxMaintenance } from "app/telegram/inbox/maintenance/inbox-maintenance";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxAttempt, InboxCleanupSettings, InboxUpdateInput, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";
import { InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import { testDatabaseSettings } from "test/database.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

// A user per group, each in the private chat of the same id.
const USERS = [5_000_000_001, 5_000_000_002, 5_000_000_003, 5_000_000_004, 5_000_000_005];
const UPDATES_PER_GROUP = 10;
const UPDATE_COUNT = USERS.length * UPDATES_PER_GROUP;
// Two slots per node, four in all, fewer than the groups: each node always has a group to claim.
const CONCURRENCY = 2;
const LONG_STOP_TIMEOUT_MS = 10_000;
const LEASE_DURATION_MS = 600_000;
// A lease the spec lets pass: the node that claimed under it never completes its update.
const SHORT_LEASE_MS = 200;
const LEASE_RECOVERY_INTERVAL_MS = 50;
// A cleanup that never runs in the spec.
const LONG_INTERVAL_MS = 60_000;
const CLEANUP: InboxCleanupSettings = { doneRetentionMs: MS_PER_DAY, skippedRetentionMs: MS_PER_DAY, batchSize: 10 };
// A retry with a delay of a millisecond: random() of 0 takes the lower end of the step, half of it.
const RETRY_DELAY = new RetryDelay({ firstDelayMs: 2, maxDelayMs: 2, multiplier: 1 }, () => 0);
const MAX_ATTEMPTS = 10;
const TOKEN = "123456789:secret";
// The longest a fake handler takes: long enough for the handlers of two nodes to overlap.
const MAX_HANDLER_MS = 5;
const SPEC_TIMEOUT_MS = 30_000;
// How often the spec counts the done updates while the loops handle them.
const DONE_POLL_INTERVAL_MS = 20;
// The handling takes well under a second with the shortest sleep of the source.
const DONE_DEADLINE_MS = 20_000;

// What the handlers of a node did, in the order the events came, across both nodes.
type HandlerEvent = { kind: "start" | "end"; userId: number; updateId: number; host: string };

// grammY as the processor uses it: records the start and the end of every handler, which takes a
// random time, and throws the errors put into it first, one per update.
class RecordingGrammy {
    public readonly errors: unknown[] = [];

    public constructor(private readonly events: HandlerEvent[], private readonly host: string) {}

    public async init(): Promise<void> {}

    public async handleUpdate(update: Update): Promise<void> {
        const userId = Number(update.message?.from.id);
        this.events.push({ kind: "start", userId: userId, updateId: update.update_id, host: this.host });

        await sleep(Math.random() * MAX_HANDLER_MS);

        this.events.push({ kind: "end", userId: userId, updateId: update.update_id, host: this.host });
        const error = this.errors.shift();

        if (error !== undefined) {
            throw error;
        }
    }
}

type Node = {
    store: InboxStore;
    grammy: RecordingGrammy;
    runner: InboxRunner;
    maintenance: InboxMaintenance;
};

describe("InboxRunner on the database", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    // A client per node.
    let firstDatabase: Database;
    let secondDatabase: Database;
    let events: HandlerEvent[];
    let logger: RecordingLogger;
    let nodes: Node[];

    before(async function () {
        const settings = await testDatabaseSettings();

        firstDatabase = new Database(settings, false);
        secondDatabase = new Database(settings, false);
    });

    beforeEach(async function () {
        events = [];
        logger = new RecordingLogger();
        nodes = [];
        await firstDatabase.sql`TRUNCATE telegram_inbox, telegram_inbox_groups`;
    });

    afterEach(async function () {
        for (const node of nodes) {
            await node.runner.stop();
            await node.maintenance.stop();
        }
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await firstDatabase?.close();
        await secondDatabase?.close();
    });

    // What keeps two updates of a session from overlapping: the bot has no queue of its own, so the
    // session row and the check-then-act of FillUserToContextMiddleware rely on this
    // (docs/architecture/invariants.md).
    it("handles the updates of every group one after another, in order, across two nodes", async function () {
        const firstNode = createNode(firstDatabase, "node-1", logger);
        const secondNode = createNode(secondDatabase, "node-2", logger);
        await firstNode.store.pushBatch(inputs());

        firstNode.runner.start();
        secondNode.runner.start();
        await waitForDone(UPDATE_COUNT);

        expect([...logger.criticals, ...logger.errors, ...logger.warnings]).to.deep.equal([]);
        for (const userId of USERS) {
            const groupEvents = events.filter((event) => event.userId === userId).map(({ kind, updateId }) => ({ kind, updateId }));

            expect(groupEvents, `the handlers of group ${userId}`).to.deep.equal(oneAfterAnother(updateIdsOf(userId)));
        }
        expect(new Set(events.map((event) => event.host))).to.deep.equal(new Set(["node-1", "node-2"]));
    });

    it("hands the update of a node that stopped without completing it to another node after the lease", async function () {
        const stoppedNode = createNode(firstDatabase, "node-1", logger, SHORT_LEASE_MS);
        const [userId] = USERS as [number];
        await stoppedNode.store.push(messageInput(1, userId, userId));
        // The node claims the update and stops before its handler completes it.
        await stoppedNode.store.claim(1, { host: "node-1", pid: 1, workerId: "node-1-runner" });
        const otherNode = createNode(secondDatabase, "node-2", logger, LEASE_DURATION_MS, LEASE_RECOVERY_INTERVAL_MS);

        otherNode.runner.start();
        otherNode.maintenance.start();
        await waitForDone(1);

        expect(events.map(({ kind, host }) => ({ kind, host }))).to.deep.equal([
            { kind: "start", host: "node-2" },
            { kind: "end", host: "node-2" },
        ]);
        const attempts = await attemptsOf(1);
        expect(attempts.map(({ worker, error }) => ({ host: worker?.host ?? null, errorName: error?.["name"] ?? null }))).to.deep.equal([
            { host: null, errorName: "InboxLeaseExpired" },
            { host: "node-2", errorName: null },
        ]);
    });

    // Handled as a failure, an ordinary restart would block the group of every update in flight.
    it("releases an update whose handler a stopped outbox wait rejected instead of blocking its group", async function () {
        const node = createNode(firstDatabase, "node-1", logger);
        const [userId] = USERS as [number];
        node.grammy.errors.push(new BotError(OutboxResultWaiterStopped.of(1), {} as Context));
        await node.store.pushBatch([messageInput(1, userId, userId), messageInput(2, userId, userId)]);

        node.runner.start();
        await waitForDone(2);

        expect(await groupStateOf(userId)).to.equal(InboxGroupState.Idle);
        const attempts = await attemptsOf(1);
        expect(attempts.map(({ worker, error }) => ({ host: worker?.host, errorName: error?.["name"] ?? null }))).to.deep.equal([
            { host: "node-1", errorName: "InboxNodeStopped" },
            { host: "node-1", errorName: null },
        ]);
        expect(events.filter((event) => event.kind === "start").map((event) => event.updateId)).to.deep.equal([1, 1, 2]);
    });

    function createNode(
        database: Database,
        host: string,
        nodeLogger: Logger,
        leaseDurationMs: number = LEASE_DURATION_MS,
        leaseRecoveryIntervalMs: number = LONG_INTERVAL_MS,
    ): Node {
        const store = new InboxStore(database, nodeLogger, leaseDurationMs, CLEANUP);
        const failureHandler = new InboxFailureHandler(
            store,
            new InboxFailureClassifier(new TelegramBotApiFailureClassifier()),
            RETRY_DELAY,
            new OutboxErrorSerializer(TOKEN),
            MAX_ATTEMPTS,
        );
        const grammy = new RecordingGrammy(events, host);
        // The shortest sleep: a claim that finds nothing ready waits 100 ms, not up to a second.
        const source = new InboxUpdateSource(store, nodeLogger, () => 0);
        const processor = new InboxUpdateProcessor(
            { grammy: grammy } as unknown as Bot,
            store,
            failureHandler,
            new InboxLeaseReleaser(store),
            nodeLogger,
            leaseDurationMs,
        );
        const worker: InboxWorker = { host, pid: 1, workerId: `${host}-runner` };
        const runner = new InboxRunner(source, processor, nodeLogger, CONCURRENCY, LONG_STOP_TIMEOUT_MS, worker);
        const maintenance = new InboxMaintenance(store, failureHandler, nodeLogger, {
            leaseRecoveryIntervalMs: leaseRecoveryIntervalMs,
            cleanupIntervalMs: LONG_INTERVAL_MS,
        });
        const node = { store, grammy, runner, maintenance };
        nodes.push(node);

        return node;
    }

    async function waitForDone(count: number): Promise<void> {
        const deadline = Date.now() + DONE_DEADLINE_MS;

        while (Date.now() <= deadline) {
            const [row] = await firstDatabase.sql<{ count: string }[]>`
                SELECT count(*) AS count
                FROM telegram_inbox
                WHERE status = ${InboxStatus.Done}
            `;

            if (Number(row?.count) === count) {
                return;
            }

            await sleep(DONE_POLL_INTERVAL_MS);
        }

        expect.fail(`the ${count} updates were expected to be done`);
    }

    async function attemptsOf(updateId: number): Promise<InboxAttempt[]> {
        const [row] = await firstDatabase.sql<{ attempts: InboxAttempt[] }[]>`
            SELECT attempts FROM telegram_inbox WHERE update_id = ${updateId}
        `;

        return row?.attempts ?? [];
    }

    async function groupStateOf(userId: number): Promise<string | undefined> {
        const [row] = await firstDatabase.sql<{ state: string }[]>`
            SELECT state FROM telegram_inbox_groups WHERE user_id = ${userId} AND chat_id = ${userId}
        `;

        return row?.state;
    }
});

// The updates of every group, interleaved across the groups in the order of the ids.
function inputs(): InboxUpdateInput[] {
    const updates: InboxUpdateInput[] = [];
    let updateId = 1;

    for (let index = 0; index < UPDATES_PER_GROUP; index += 1) {
        for (const userId of USERS) {
            updates.push(messageInput(updateId, userId, userId));
            updateId += 1;
        }
    }

    return updates;
}

function updateIdsOf(userId: number): number[] {
    return inputs()
        .filter((input) => input.userId === userId)
        .map((input) => input.update.update_id);
}

// Each handler ends before the next one of the group starts.
function oneAfterAnother(updateIds: number[]): { kind: "start" | "end"; updateId: number }[] {
    return updateIds.flatMap((updateId) => [
        { kind: "start" as const, updateId },
        { kind: "end" as const, updateId },
    ]);
}
