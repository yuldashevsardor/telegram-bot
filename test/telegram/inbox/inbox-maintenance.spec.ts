import { expect } from "chai";
import { sleep } from "app/shared/utils";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { InboxMaintenance } from "app/telegram/inbox/maintenance/inbox-maintenance";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxMaintenanceSettings } from "app/telegram/inbox/maintenance/inbox-maintenance.types";
import { WAIT_UNTIL_DEADLINE_MS, waitUntil } from "test/shared/utils.helper";
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
// A number of blocked groups the fake store answers: any number above zero.
const BLOCKED_GROUP_COUNT = 2;
// The default timeout of mocha, 2 s, is shorter than the deadline of waitUntil and would fail a
// condition that never comes true before waitUntil gives its own message.
const SPEC_TIMEOUT_MS = 2 * WAIT_UNTIL_DEADLINE_MS;

// A run that goes on until the spec ends it.
type HeldRun = { end: () => void };

// Each delete answers the next count of its queue, and 0 once the queue is empty.
class FakeStore {
    public readonly finishedUpdatesDeleted: number[] = [];
    public readonly idleGroupsDeleted: number[] = [];
    public finishedUpdatesCalls = 0;
    public idleGroupsCalls = 0;
    public onDeleteFinishedUpdates: () => void = () => {};
    public finishedUpdatesError: unknown = undefined;
    public idleGroupsError: unknown = undefined;
    public blockedGroupCount = 0;
    public blockedGroupCountCalls = 0;
    public blockedGroupCountError: unknown = undefined;

    public async deleteFinishedUpdates(): Promise<number> {
        this.finishedUpdatesCalls += 1;
        this.onDeleteFinishedUpdates();

        if (this.finishedUpdatesError !== undefined) {
            throw this.finishedUpdatesError;
        }

        return this.finishedUpdatesDeleted.shift() ?? 0;
    }

    public async deleteIdleGroups(): Promise<number> {
        this.idleGroupsCalls += 1;

        if (this.idleGroupsError !== undefined) {
            throw this.idleGroupsError;
        }

        return this.idleGroupsDeleted.shift() ?? 0;
    }

    public async countBlockedGroups(): Promise<number> {
        this.blockedGroupCountCalls += 1;

        if (this.blockedGroupCountError !== undefined) {
            throw this.blockedGroupCountError;
        }

        return this.blockedGroupCount;
    }
}

class FakeFailureHandler {
    public recoveries = 0;
    public error: unknown = undefined;
    // While set, a recovery goes on until the spec ends it.
    public shouldHold = false;
    public readonly heldRuns: HeldRun[] = [];

    public async recoverExpiredLeases(): Promise<void> {
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

describe("InboxMaintenance", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let store: FakeStore;
    let failureHandler: FakeFailureHandler;
    let logger: RecordingLogger;
    let maintenance: InboxMaintenance | undefined;

    beforeEach(function () {
        store = new FakeStore();
        failureHandler = new FakeFailureHandler();
        logger = new RecordingLogger();
        maintenance = undefined;
    });

    afterEach(async function () {
        for (const heldRun of failureHandler.heldRuns) {
            heldRun.end();
        }

        await maintenance?.stop();
    });

    it("runs nothing before the first interval has passed", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS, blockedLogIntervalMs: LONG_INTERVAL_MS });
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedUpdatesCalls).to.equal(0);
        expect(store.idleGroupsCalls).to.equal(0);
        expect(store.blockedGroupCountCalls).to.equal(0);
    });

    it("recovers the expired leases once per interval", async function () {
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => failureHandler.recoveries >= 2, "the recovery was expected to run twice");

        expect(store.finishedUpdatesCalls).to.equal(0);
        expect(store.idleGroupsCalls).to.equal(0);
        expect(store.blockedGroupCountCalls).to.equal(0);
    });

    it("runs both cleanups once per interval", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => store.finishedUpdatesCalls >= 2 && store.idleGroupsCalls >= 2, "both cleanups were expected to run twice");

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.blockedGroupCountCalls).to.equal(0);
    });

    it("logs the number of the blocked groups at error once per interval while there are any", async function () {
        store.blockedGroupCount = BLOCKED_GROUP_COUNT;
        const started = start({
            leaseRecoveryIntervalMs: LONG_INTERVAL_MS,
            cleanupIntervalMs: LONG_INTERVAL_MS,
            blockedLogIntervalMs: SHORT_INTERVAL_MS,
        });

        await waitUntil(() => store.blockedGroupCountCalls >= 2, "the blocked groups were expected to be counted twice");
        await started.stop();

        // One line per count: a run that logged twice would show here.
        expect(logger.errors).to.have.length(store.blockedGroupCountCalls);
        for (const loggedError of logger.errors) {
            expect(loggedError).to.deep.equal({
                message:
                    'Inbox groups are blocked: find them and unblock each with make inbox-retry user=<id> chat=<id> or make inbox-skip user=<id> chat=<id> (README.md, "Unblocking a chat or a group").',
                payload: { blockedGroupCount: BLOCKED_GROUP_COUNT },
            });
        }
        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedUpdatesCalls).to.equal(0);
        expect(store.idleGroupsCalls).to.equal(0);
    });

    it("logs nothing while no group is blocked", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS, blockedLogIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => store.blockedGroupCountCalls >= 2, "the blocked groups were expected to be counted twice");

        expect(logger.errors).to.deep.equal([]);
    });

    it("deletes again after a batch that deleted anything and stops at the first empty one", async function () {
        store.finishedUpdatesDeleted.push(DELETED_COUNT, DELETED_COUNT, DELETED_COUNT - 1);
        store.idleGroupsDeleted.push(DELETED_COUNT);
        const started = start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SPACED_INTERVAL_MS });

        await waitUntil(
            () => store.finishedUpdatesCalls >= 4 && store.idleGroupsCalls >= 2,
            "both cleanups were expected to delete every batch",
        );
        await started.stop();

        // The last call of each deleted nothing.
        expect(store.finishedUpdatesCalls).to.equal(4);
        expect(store.idleGroupsCalls).to.equal(2);
    });

    it("logs a failed run and runs the task again on the next interval", async function () {
        const error = new Error("connection lost");
        failureHandler.error = error;
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => failureHandler.recoveries >= 2, "the recovery was expected to run again after a failure");

        expect(logger.errors[0]).to.deep.equal({
            message: "An inbox maintenance task failed, its next run tries again.",
            payload: { task: "recoverExpiredLeases", cause: error },
        });
    });

    it("names the failed cleanup of the finished updates in the log", async function () {
        const error = new Error("connection lost");
        store.finishedUpdatesError = error;
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => logger.errors.length > 0, "the failure of the cleanup was expected to be logged");

        expect(logger.errors[0]).to.deep.equal({
            message: "An inbox maintenance task failed, its next run tries again.",
            payload: { task: "deleteFinishedUpdates", cause: error },
        });
    });

    it("names the failed cleanup of the idle groups in the log", async function () {
        const error = new Error("connection lost");
        store.idleGroupsError = error;
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => logger.errors.length > 0, "the failure of the cleanup was expected to be logged");

        expect(logger.errors[0]).to.deep.equal({
            message: "An inbox maintenance task failed, its next run tries again.",
            payload: { task: "deleteIdleGroups", cause: error },
        });
    });

    it("names the failed count of the blocked groups in the log and counts again on the next interval", async function () {
        const error = new Error("connection lost");
        store.blockedGroupCountError = error;
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS, blockedLogIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => store.blockedGroupCountCalls >= 2, "the count was expected to run again after a failure");

        expect(logger.errors[0]).to.deep.equal({
            message: "An inbox maintenance task failed, its next run tries again.",
            payload: { task: "logBlockedGroups", cause: error },
        });
    });

    it("starts no run of a task while its previous run goes on", async function () {
        failureHandler.shouldHold = true;
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await waitUntil(() => failureHandler.recoveries === 1, "the recovery was expected to start");

        await sleep(SEVERAL_INTERVALS_MS);
        expect(failureHandler.recoveries).to.equal(1);

        failureHandler.shouldHold = false;
        failureHandler.heldRuns[0]?.end();
        await waitUntil(() => failureHandler.recoveries >= 2, "the recovery was expected to run again once the first run ended");
    });

    it("runs nothing after the stop", async function () {
        const started = start({
            leaseRecoveryIntervalMs: SHORT_INTERVAL_MS,
            cleanupIntervalMs: SHORT_INTERVAL_MS,
            blockedLogIntervalMs: SHORT_INTERVAL_MS,
        });

        await started.stop();
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedUpdatesCalls).to.equal(0);
        expect(store.idleGroupsCalls).to.equal(0);
        expect(store.blockedGroupCountCalls).to.equal(0);
    });

    // The stop is final: a start that follows it sets no timers.
    it("runs nothing when started after the stop", async function () {
        const stopped = start({
            leaseRecoveryIntervalMs: SHORT_INTERVAL_MS,
            cleanupIntervalMs: SHORT_INTERVAL_MS,
            blockedLogIntervalMs: SHORT_INTERVAL_MS,
        });
        await stopped.stop();

        stopped.start();
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedUpdatesCalls).to.equal(0);
        expect(store.idleGroupsCalls).to.equal(0);
        expect(store.blockedGroupCountCalls).to.equal(0);
    });

    it("waits for the run in progress and schedules no next one", async function () {
        failureHandler.shouldHold = true;
        const started = start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await waitUntil(() => failureHandler.recoveries === 1, "the recovery was expected to start");

        let isStopped = false;
        const stopping = started.stop().then(() => {
            isStopped = true;
        });
        await sleep(SEVERAL_INTERVALS_MS);
        expect(isStopped).to.equal(false);

        failureHandler.heldRuns[0]?.end();
        await stopping;
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(1);
    });

    it("deletes no further batch after the stop", async function () {
        store.finishedUpdatesDeleted.push(DELETED_COUNT, DELETED_COUNT, DELETED_COUNT);
        const started = start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });
        // The stop comes while the first batch is being deleted.
        let stopping: Promise<void> | undefined;
        store.onDeleteFinishedUpdates = (): void => {
            stopping ??= started.stop();
        };

        await waitUntil(() => stopping !== undefined, "the cleanup was expected to start");
        await stopping;

        expect(store.finishedUpdatesCalls).to.equal(1);
    });

    // The line of the blocked groups is left out of the specs that do not name its interval.
    function start(
        intervals: Omit<InboxMaintenanceSettings, "blockedLogIntervalMs"> & Partial<InboxMaintenanceSettings>,
    ): InboxMaintenance {
        maintenance = new InboxMaintenance(store as unknown as InboxStore, failureHandler as unknown as InboxFailureHandler, logger, {
            blockedLogIntervalMs: LONG_INTERVAL_MS,
            ...intervals,
        });
        maintenance.start();

        return maintenance;
    }
});
