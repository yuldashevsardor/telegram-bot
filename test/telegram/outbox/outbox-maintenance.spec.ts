import { expect } from "chai";
import { sleep } from "app/shared/utils";
import type { OutboxLeaseRecovery } from "app/telegram/outbox/lease/outbox-lease-recovery";
import { OutboxMaintenance } from "app/telegram/outbox/maintenance/outbox-maintenance";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { waitUntil } from "test/telegram/outbox/outbox-store.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const SHORT_INTERVAL_MS = 5;
// Longer than any spec runs: a task with it never runs in the spec.
const LONG_INTERVAL_MS = 60_000;
// A count of deleted rows the fake store answers: any count above zero.
const DELETED_COUNT = 3;
// Long enough for several runs of a task with SHORT_INTERVAL_MS.
const SEVERAL_INTERVALS_MS = 20 * SHORT_INTERVAL_MS;
// Long enough for the spec to see one run end and stop the timers before the next run.
const SPACED_INTERVAL_MS = 100;

// A run that goes on until the spec ends it.
type HeldRun = { end: () => void };

// Each delete answers the next count of its queue, and 0 once the queue is empty.
class FakeStore {
    public readonly finishedMessagesDeleted: number[] = [];
    public readonly idleChatsDeleted: number[] = [];
    public finishedMessagesCalls = 0;
    public idleChatsCalls = 0;
    public onDeleteFinishedMessages: () => void = () => {};
    public finishedMessagesError: unknown = undefined;
    public idleChatsError: unknown = undefined;

    public async deleteFinishedMessages(): Promise<number> {
        this.finishedMessagesCalls += 1;
        this.onDeleteFinishedMessages();

        if (this.finishedMessagesError !== undefined) {
            throw this.finishedMessagesError;
        }

        return this.finishedMessagesDeleted.shift() ?? 0;
    }

    public async deleteIdleChats(): Promise<number> {
        this.idleChatsCalls += 1;

        if (this.idleChatsError !== undefined) {
            throw this.idleChatsError;
        }

        return this.idleChatsDeleted.shift() ?? 0;
    }
}

class FakeLeaseRecovery {
    public recoveries = 0;
    public error: unknown = undefined;
    // While set, a recovery goes on until the spec ends it.
    public shouldHold = false;
    public readonly heldRuns: HeldRun[] = [];

    public async recover(): Promise<void> {
        this.recoveries += 1;

        if (this.shouldHold) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.heldRuns.push({ end: resolve });
            await promise;
        }

        if (this.error !== undefined) {
            throw this.error;
        }
    }
}

describe("OutboxMaintenance", function () {
    let store: FakeStore;
    let leaseRecovery: FakeLeaseRecovery;
    let logger: RecordingLogger;
    let maintenance: OutboxMaintenance | undefined;

    beforeEach(function () {
        store = new FakeStore();
        leaseRecovery = new FakeLeaseRecovery();
        logger = new RecordingLogger();
        maintenance = undefined;
    });

    afterEach(async function () {
        for (const heldRun of leaseRecovery.heldRuns) {
            heldRun.end();
        }

        await maintenance?.stop();
    });

    it("runs nothing before the first interval has passed", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await sleep(SEVERAL_INTERVALS_MS);

        expect(leaseRecovery.recoveries).to.equal(0);
        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
    });

    it("recovers the expired leases once per interval", async function () {
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => leaseRecovery.recoveries >= 2, "the recovery was expected to run twice");

        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
    });

    it("runs both cleanups once per interval", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => store.finishedMessagesCalls >= 2 && store.idleChatsCalls >= 2, "both cleanups were expected to run twice");

        expect(leaseRecovery.recoveries).to.equal(0);
    });

    it("deletes again after a batch that deleted anything and stops at the first empty one", async function () {
        store.finishedMessagesDeleted.push(DELETED_COUNT, DELETED_COUNT, DELETED_COUNT - 1);
        store.idleChatsDeleted.push(DELETED_COUNT);
        const started = start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SPACED_INTERVAL_MS });

        await waitUntil(
            () => store.finishedMessagesCalls >= 4 && store.idleChatsCalls >= 2,
            "both cleanups were expected to delete every batch",
        );
        await started.stop();

        // The last call of each deleted nothing.
        expect(store.finishedMessagesCalls).to.equal(4);
        expect(store.idleChatsCalls).to.equal(2);
    });

    it("logs a failed run and runs the task again on the next interval", async function () {
        const error = new Error("connection lost");
        leaseRecovery.error = error;
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => leaseRecovery.recoveries >= 2, "the recovery was expected to run again after a failure");

        expect(logger.errors[0]).to.deep.equal({
            message: "An outbox maintenance task failed, its next run tries again.",
            payload: { task: "recoverLeases", cause: error },
        });
    });

    it("names the failed cleanup of the finished messages in the log", async function () {
        const error = new Error("connection lost");
        store.finishedMessagesError = error;
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => logger.errors.length > 0, "the failure of the cleanup was expected to be logged");

        expect(logger.errors[0]).to.deep.equal({
            message: "An outbox maintenance task failed, its next run tries again.",
            payload: { task: "deleteFinishedMessages", cause: error },
        });
    });

    it("names the failed cleanup of the idle chats in the log", async function () {
        const error = new Error("connection lost");
        store.idleChatsError = error;
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => logger.errors.length > 0, "the failure of the cleanup was expected to be logged");

        expect(logger.errors[0]).to.deep.equal({
            message: "An outbox maintenance task failed, its next run tries again.",
            payload: { task: "deleteIdleChats", cause: error },
        });
    });

    it("starts no run of a task while its previous run goes on", async function () {
        leaseRecovery.shouldHold = true;
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await waitUntil(() => leaseRecovery.recoveries === 1, "the recovery was expected to start");

        await sleep(SEVERAL_INTERVALS_MS);
        expect(leaseRecovery.recoveries).to.equal(1);

        leaseRecovery.shouldHold = false;
        leaseRecovery.heldRuns[0]?.end();
        await waitUntil(() => leaseRecovery.recoveries >= 2, "the recovery was expected to run again once the first run ended");
    });

    it("runs nothing after the stop", async function () {
        const started = start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await started.stop();
        await sleep(SEVERAL_INTERVALS_MS);

        expect(leaseRecovery.recoveries).to.equal(0);
        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
    });

    it("waits for the run in progress and schedules no next one", async function () {
        leaseRecovery.shouldHold = true;
        const started = start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await waitUntil(() => leaseRecovery.recoveries === 1, "the recovery was expected to start");

        let isStopped = false;
        const stopping = started.stop().then(() => {
            isStopped = true;
        });
        await sleep(SEVERAL_INTERVALS_MS);
        expect(isStopped).to.equal(false);

        leaseRecovery.heldRuns[0]?.end();
        await stopping;
        await sleep(SEVERAL_INTERVALS_MS);

        expect(leaseRecovery.recoveries).to.equal(1);
    });

    it("deletes no further batch after the stop", async function () {
        store.finishedMessagesDeleted.push(DELETED_COUNT, DELETED_COUNT, DELETED_COUNT);
        const started = start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });
        // The stop comes while the first batch is being deleted.
        let stopping: Promise<void> | undefined;
        store.onDeleteFinishedMessages = (): void => {
            stopping ??= started.stop();
        };

        await waitUntil(() => stopping !== undefined, "the cleanup was expected to start");
        await stopping;

        expect(store.finishedMessagesCalls).to.equal(1);
    });

    function start(intervals: { leaseRecoveryIntervalMs: number; cleanupIntervalMs: number }): OutboxMaintenance {
        maintenance = new OutboxMaintenance(
            store as unknown as OutboxStore,
            leaseRecovery as unknown as OutboxLeaseRecovery,
            logger,
            intervals,
        );
        maintenance.start();

        return maintenance;
    }
});
