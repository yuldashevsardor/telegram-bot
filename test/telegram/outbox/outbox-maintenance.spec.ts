import { expect } from "chai";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { sleep } from "app/shared/utils";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxMaintenance } from "app/telegram/outbox/outbox-maintenance";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { waitUntil } from "test/telegram/outbox/outbox-store.helper";

const SHORT_INTERVAL_MS = 5;
// Longer than any spec runs: a task with it never runs in the spec.
const LONG_INTERVAL_MS = 60_000;
const BATCH_SIZE = 3;
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

    public async deleteFinishedMessages(): Promise<number> {
        this.finishedMessagesCalls += 1;
        this.onDeleteFinishedMessages();

        return this.finishedMessagesDeleted.shift() ?? 0;
    }

    public async deleteIdleChats(): Promise<number> {
        this.idleChatsCalls += 1;

        return this.idleChatsDeleted.shift() ?? 0;
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

type LogRecord = { message: string; payload: UnknownObject | undefined };

class RecordingLogger implements Logger {
    public readonly errors: LogRecord[] = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message, payload });
    }

    public warning(): void {}

    public info(): void {}

    public debug(): void {}
}

describe("OutboxMaintenance", function () {
    let store: FakeStore;
    let failureHandler: FakeFailureHandler;
    let logger: RecordingLogger;
    let maintenance: OutboxMaintenance | undefined;

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
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
    });

    it("recovers the expired leases once per interval", async function () {
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => failureHandler.recoveries >= 2, "the recovery was expected to run twice");

        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
    });

    it("runs both cleanups once per interval", async function () {
        start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await waitUntil(() => store.finishedMessagesCalls >= 2 && store.idleChatsCalls >= 2, "both cleanups were expected to run twice");

        expect(failureHandler.recoveries).to.equal(0);
    });

    it("deletes again after a full batch and stops at the first batch that is not full", async function () {
        store.finishedMessagesDeleted.push(BATCH_SIZE, BATCH_SIZE, BATCH_SIZE - 1);
        store.idleChatsDeleted.push(BATCH_SIZE, 0);
        const started = start({ leaseRecoveryIntervalMs: LONG_INTERVAL_MS, cleanupIntervalMs: SPACED_INTERVAL_MS });

        await waitUntil(
            () => store.finishedMessagesCalls >= 3 && store.idleChatsCalls >= 2,
            "both cleanups were expected to delete every batch",
        );
        await started.stop();

        expect(store.finishedMessagesCalls).to.equal(3);
        expect(store.idleChatsCalls).to.equal(2);
    });

    it("logs a failed run and runs the task again on the next interval", async function () {
        const error = new Error("connection lost");
        failureHandler.error = error;
        start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: LONG_INTERVAL_MS });

        await waitUntil(() => failureHandler.recoveries >= 2, "the recovery was expected to run again after a failure");

        expect(logger.errors[0]).to.deep.equal({
            message: "An outbox maintenance task failed, its next run tries again.",
            payload: { task: "recoverExpiredLeases", cause: error },
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
        const started = start({ leaseRecoveryIntervalMs: SHORT_INTERVAL_MS, cleanupIntervalMs: SHORT_INTERVAL_MS });

        await started.stop();
        await sleep(SEVERAL_INTERVALS_MS);

        expect(failureHandler.recoveries).to.equal(0);
        expect(store.finishedMessagesCalls).to.equal(0);
        expect(store.idleChatsCalls).to.equal(0);
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
        store.finishedMessagesDeleted.push(BATCH_SIZE, BATCH_SIZE, BATCH_SIZE);
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
            failureHandler as unknown as OutboxFailureHandler,
            logger,
            intervals.leaseRecoveryIntervalMs,
            intervals.cleanupIntervalMs,
            BATCH_SIZE,
        );
        maintenance.start();

        return maintenance;
    }
});
