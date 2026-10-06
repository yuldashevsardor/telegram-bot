import { expect } from "chai";
import type { Bot } from "app/telegram/bot/bot";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import { InboxRunner } from "app/telegram/inbox/inbox-runner";
import { InboxUpdateProcessor } from "app/telegram/inbox/inbox-update-processor";
import type { InboxUpdateSource } from "app/telegram/inbox/inbox-update-source";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxAttemptError, InboxLease, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

const USER = 5_000_000_001;
const WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
const CONCURRENCY = 2;
// Longer than any spec waits: a stop that reaches it has given up on a handler it should have waited
// for.
const LONG_STOP_TIMEOUT_MS = 10_000;
const SHORT_STOP_TIMEOUT_MS = 50;
const LEASE_DURATION_MS = 600_000;
// setTimeout() may fire a little before its delay on some platforms.
const TIMER_TOLERANCE_MS = 5;

// Hands out the updates put into it, one per next(), and waits for more when it has none. Ends on
// stop(), as the real source does from a sleep.
class FakeSource {
    public readonly workers: InboxWorker[] = [];
    public readonly waiting: ClaimedInboxUpdate[] = [];
    public isStopped = false;
    private wakeUp: (() => void) | undefined;

    public add(...updates: ClaimedInboxUpdate[]): void {
        this.waiting.push(...updates);
        this.wakeUp?.();
    }

    public async *stream(worker: InboxWorker): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
        this.workers.push(worker);

        while (!this.isStopped) {
            const update = this.waiting.shift();

            if (update !== undefined) {
                yield update;
                continue;
            }

            await new Promise<void>((resolve) => {
                this.wakeUp = resolve;
            });
        }
    }

    public stop(): void {
        this.isStopped = true;
        this.wakeUp?.();
    }
}

type ProcessCall = {
    update: ClaimedInboxUpdate;
    signal: AbortSignal;
    finish: () => void;
    fail: (error: unknown) => void;
};

// Each call runs until the spec finishes or fails it, as a handler does: an abort does not cut it
// short. A call starts its handler at once; with shouldStartHandler off it stays before its handler, as
// one in init() does. A signal aborted before the call settles it at once, as the real processor
// releases such an update.
class FakeProcessor {
    public readonly calls: ProcessCall[] = [];
    public shouldStartHandler = true;

    public process(update: ClaimedInboxUpdate, signal: AbortSignal, onHandlerStart: () => void): Promise<void> {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const call: ProcessCall = {
            update,
            signal,
            finish: () => resolve(),
            fail: (error: unknown) => reject(error),
        };
        this.calls.push(call);

        if (signal.aborted) {
            call.finish();
        } else if (this.shouldStartHandler) {
            onHandlerStart();
        }

        return promise;
    }
}

type Retry = { lease: InboxLease; attemptError: InboxAttemptError; delayMs: number };

class RecordingStore {
    public readonly retries: Retry[] = [];
    public readonly done: InboxLease[] = [];

    public async retry(lease: InboxLease, attemptError: InboxAttemptError, delayMs: number): Promise<void> {
        this.retries.push({ lease, attemptError, delayMs });
    }

    public async markAsDone(lease: InboxLease): Promise<void> {
        this.done.push(lease);
    }

    public async extendLease(): Promise<boolean> {
        return true;
    }
}

// Records the updates it handles.
class RecordingGrammy {
    public readonly handledUpdateIds: number[] = [];

    public async init(): Promise<void> {}

    public async handleUpdate(update: { update_id: number }): Promise<void> {
        this.handledUpdateIds.push(update.update_id);
    }
}

describe("InboxRunner", function () {
    let source: FakeSource;
    let processor: FakeProcessor;
    let logger: RecordingLogger;

    beforeEach(function () {
        source = new FakeSource();
        processor = new FakeProcessor();
        logger = new RecordingLogger();
    });

    it("takes the updates of its own worker from the source", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);

        runner.start();
        await settle();

        expect(source.workers).to.deep.equal([WORKER]);
        await runner.stop();
    });

    it("handles as many updates at once as it has slots and leaves the rest in the source", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        source.add(update(1), update(2), update(3));

        runner.start();
        await settle();

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1, 2]);
        expect(source.waiting.map((waiting) => waiting.updateId)).to.deep.equal([3]);
        await stopFinishingCalls(runner);
    });

    it("takes the next update once a slot is free", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        source.add(update(1), update(2), update(3));
        runner.start();
        await settle();

        processor.calls[1]?.finish();
        await settle();

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1, 2, 3]);
        await stopFinishingCalls(runner);
    });

    it("takes an update added while it waits for one", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        runner.start();
        await settle();

        source.add(update(1));
        await settle();

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1]);
        await stopFinishingCalls(runner);
    });

    it("logs an update that was not completed and frees its slot", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        const error = new Error("connection lost");
        source.add(update(1), update(2), update(3));
        runner.start();
        await settle();

        processor.calls[0]?.fail(error);
        await settle();

        expect(logger.errors).to.deep.equal([
            {
                message: "An inbox update was not completed, the recovery of its lease takes it back.",
                payload: { updateId: 1, cause: error },
            },
        ]);
        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1, 2, 3]);
        await stopFinishingCalls(runner);
    });

    it("logs a process() that throws synchronously and frees its slot", async function () {
        const error = new Error("thrown synchronously");
        const throwingProcessor = {
            process(): Promise<void> {
                throw error;
            },
        };
        const runner = new InboxRunner(
            source as unknown as InboxUpdateSource,
            throwingProcessor as unknown as InboxUpdateProcessor,
            logger,
            1,
            LONG_STOP_TIMEOUT_MS,
            WORKER,
        );
        source.add(update(1), update(2));

        runner.start();
        await settle();

        expect(logger.errors.map((record) => record.payload)).to.deep.equal([
            { updateId: 1, cause: error },
            { updateId: 2, cause: error },
        ]);
        await runner.stop();
    });

    it("frees the slot of an update whose error log throws, and rejects nothing", async function () {
        const unhandledRejections = recordUnhandledRejections();
        logger.error = (): void => {
            throw new Error("the log failed");
        };
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        source.add(update(1), update(2), update(3));
        runner.start();
        await settle();

        processor.calls[0]?.fail(new Error("connection lost"));
        await settle();

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1, 2, 3]);
        await stopFinishingCalls(runner);
        expect(unhandledRejections.stop()).to.deep.equal([]);
    });

    it("logs a source that throws, takes no more updates and still stops", async function () {
        const unhandledRejections = recordUnhandledRejections();
        const error = new Error("the source failed");
        const throwingSource = {
            async *stream(): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
                yield update(1);
                throw error;
            },
            stop(): void {},
        };
        const runner = new InboxRunner(
            throwingSource as unknown as InboxUpdateSource,
            processor as unknown as InboxUpdateProcessor,
            logger,
            CONCURRENCY,
            LONG_STOP_TIMEOUT_MS,
            WORKER,
        );

        runner.start();
        await settle();

        expect(logger.errors).to.deep.equal([
            { message: "The inbox update source failed, the runner takes no more updates.", payload: { cause: error } },
        ]);
        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1]);
        await stopFinishingCalls(runner);
        expect(unhandledRejections.stop()).to.deep.equal([]);
    });

    it("stops the source on stop", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        runner.start();

        await runner.stop();

        expect(source.isStopped).to.equal(true);
    });

    it("takes no update after the stop while every slot is busy", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        source.add(update(1), update(2));
        runner.start();
        await settle();

        const stopped = runner.stop();
        source.add(update(3));
        processor.calls[0]?.finish();
        processor.calls[1]?.finish();
        await stopped;

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1, 2]);
    });

    it("waits for the handlers in flight and aborts none that finish before the deadline", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);
        source.add(update(1), update(2));
        runner.start();
        await settle();

        let isStopped = false;
        const stopped = runner.stop().then(() => {
            isStopped = true;
        });
        await settle();

        expect(isStopped).to.equal(false);
        processor.calls[0]?.finish();
        await settle();
        expect(isStopped).to.equal(false);
        processor.calls[1]?.finish();
        await stopped;

        expect(processor.calls.map((call) => call.signal.aborted)).to.deep.equal([false, false]);
        expect(logger.warnings).to.deep.equal([]);
    });

    // A handler cannot be cut short: waiting for it would hold up the stop for as long as it runs.
    it("aborts the handlers still running at the deadline, leaves them running and logs them", async function () {
        const runner = createRunner(SHORT_STOP_TIMEOUT_MS);
        source.add(update(1), update(2), update(3));
        runner.start();
        await settle();
        processor.calls[0]?.finish();
        await settle();
        const startedAt = Date.now();

        await runner.stop();

        expect(Date.now() - startedAt).to.be.at.least(SHORT_STOP_TIMEOUT_MS - TIMER_TOLERANCE_MS);
        expect(processor.calls.map((call) => [call.update.updateId, call.signal.aborted])).to.deep.equal([
            [1, false],
            [2, true],
            [3, true],
        ]);
        expect(logger.warnings).to.deep.equal([
            {
                message: "The inbox runner stopped with handlers still running, their updates wait for their own outcome or the lease.",
                payload: { updateIds: [2, 3] },
            },
        ]);
        processor.calls[1]?.finish();
        processor.calls[2]?.finish();
    });

    // The release is a write to the database, which is closed after the stop.
    it("waits at the deadline for the release of an update its handler has not reached", async function () {
        const runner = createRunner(SHORT_STOP_TIMEOUT_MS);
        processor.shouldStartHandler = false;
        source.add(update(1));
        runner.start();
        await settle();
        processor.shouldStartHandler = true;
        source.add(update(2));
        await settle();

        let isStopped = false;
        const stopped = runner.stop().then(() => {
            isStopped = true;
        });
        await waitForAbort(processor.calls[0]);
        await settle();

        expect(isStopped).to.equal(false);
        processor.calls[0]?.finish();
        await stopped;
        expect(logger.warnings.map((record) => record.payload)).to.deep.equal([{ updateIds: [2] }]);
        processor.calls[1]?.finish();
    });

    it("logs no handler left running when every update at the deadline was kept from its handler", async function () {
        const runner = createRunner(SHORT_STOP_TIMEOUT_MS);
        processor.shouldStartHandler = false;
        source.add(update(1));
        runner.start();
        await settle();

        const stopped = runner.stop();
        await waitForAbort(processor.calls[0]);
        processor.calls[0]?.finish();
        await stopped;

        expect(logger.warnings).to.deep.equal([]);
    });

    it("gives up on the handlers in flight at once with a deadline of zero", async function () {
        const runner = createRunner(0);
        source.add(update(1));
        runner.start();
        await settle();

        await runner.stop();

        expect(processor.calls.map((call) => call.signal.aborted)).to.deep.equal([true]);
        processor.calls[0]?.finish();
    });

    // The source ends a generator whose claim is in progress only once it has handed out what the
    // claim got: left unhandled, the update would wait for the recovery of its lease.
    it("handles the update a claim in progress hands out after the stop", async function () {
        const { runner, claim } = createRunnerOverClaimInProgress(LONG_STOP_TIMEOUT_MS);
        runner.start();
        await settle();

        const stopped = runner.stop();
        claim.resolve(update(1));
        await settle();

        expect(processor.calls.map((call) => [call.update.updateId, call.signal.aborted])).to.deep.equal([[1, false]]);
        processor.calls[0]?.finish();
        await stopped;
    });

    it("starts aborted the update a claim in progress hands out after the deadline", async function () {
        const { runner, claim } = createRunnerOverClaimInProgress(0);
        runner.start();
        await settle();

        const stopped = runner.stop();
        claim.resolve(update(1));
        await settle();

        expect(processor.calls.map((call) => [call.update.updateId, call.signal.aborted])).to.deep.equal([[1, true]]);
        await stopped;
        expect(logger.warnings).to.deep.equal([]);
    });

    // The real processor and releaser over a fake store: what reaches the inbox of an update handed
    // out after the deadline.
    it("releases the update a claim in progress hands out after the deadline without handling it", async function () {
        const store = new RecordingStore();
        const grammy = new RecordingGrammy();
        const realProcessor = new InboxUpdateProcessor(
            { grammy: grammy } as unknown as Bot,
            store as unknown as InboxStore,
            {} as InboxFailureHandler,
            new InboxLeaseReleaser(store as unknown as InboxStore),
            logger,
            LEASE_DURATION_MS,
        );
        const claim = Promise.withResolvers<ClaimedInboxUpdate>();
        const claimingSource = {
            async *stream(): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
                yield await claim.promise;
            },
            stop(): void {},
        };
        const runner = new InboxRunner(claimingSource as unknown as InboxUpdateSource, realProcessor, logger, CONCURRENCY, 0, WORKER);
        const claimed = update(1);
        runner.start();
        await settle();

        const stopped = runner.stop();
        claim.resolve(claimed);
        await stopped;

        expect(grammy.handledUpdateIds).to.deep.equal([]);
        expect(store.retries).to.have.lengthOf(1);
        expect(store.retries[0]?.lease).to.equal(claimed);
        expect(store.retries[0]?.attemptError).to.include({ name: "InboxNodeStopped", kind: InboxFailureKind.Transient });
        expect(store.retries[0]?.delayMs).to.equal(0);
        expect(store.done).to.deep.equal([]);
    });

    it("takes no further update from a source that goes on handing them out after the stop", async function () {
        const claim = Promise.withResolvers<ClaimedInboxUpdate>();
        const stubbornSource = {
            async *stream(): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
                yield await claim.promise;
                yield update(2);
            },
            stop(): void {},
        };
        const runner = new InboxRunner(
            stubbornSource as unknown as InboxUpdateSource,
            processor as unknown as InboxUpdateProcessor,
            logger,
            CONCURRENCY,
            LONG_STOP_TIMEOUT_MS,
            WORKER,
        );
        runner.start();
        await settle();

        const stopped = runner.stop();
        claim.resolve(update(1));
        await settle();

        expect(processor.calls.map((call) => call.update.updateId)).to.deep.equal([1]);
        processor.calls[0]?.finish();
        await stopped;
    });

    it("stops before it was started", async function () {
        const runner = createRunner(LONG_STOP_TIMEOUT_MS);

        await runner.stop();

        expect(source.isStopped).to.equal(true);
        expect(processor.calls).to.deep.equal([]);
    });

    function createRunner(stopTimeoutMs: number): InboxRunner {
        return new InboxRunner(
            source as unknown as InboxUpdateSource,
            processor as unknown as InboxUpdateProcessor,
            logger,
            CONCURRENCY,
            stopTimeoutMs,
            WORKER,
        );
    }

    // A runner over a source whose one claim is in progress until the spec resolves claim: the source
    // hands out what the claim got even after its stop.
    function createRunnerOverClaimInProgress(stopTimeoutMs: number): {
        runner: InboxRunner;
        claim: PromiseWithResolvers<ClaimedInboxUpdate>;
    } {
        const claim = Promise.withResolvers<ClaimedInboxUpdate>();
        const claimingSource = {
            async *stream(): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
                yield await claim.promise;
            },
            stop(): void {},
        };
        const runner = new InboxRunner(
            claimingSource as unknown as InboxUpdateSource,
            processor as unknown as InboxUpdateProcessor,
            logger,
            CONCURRENCY,
            stopTimeoutMs,
            WORKER,
        );

        return { runner, claim };
    }

    // Stops the runner and finishes the handlers in flight, so the stop has no deadline to wait for.
    async function stopFinishingCalls(runner: InboxRunner): Promise<void> {
        const stopped = runner.stop();

        for (const call of processor.calls) {
            call.finish();
        }

        await stopped;
    }
});

async function waitForAbort(call: ProcessCall | undefined): Promise<void> {
    if (call === undefined) {
        expect.fail("the call was expected to have started");
    }

    if (call.signal.aborted) {
        return;
    }

    await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve()));
}

// Collects the rejections nobody handled until stop(): the runner promises none.
function recordUnhandledRejections(): { stop: () => unknown[] } {
    const reasons: unknown[] = [];
    const listener = (reason: unknown): void => {
        reasons.push(reason);
    };
    process.on("unhandledRejection", listener);

    return {
        stop: (): unknown[] => {
            process.off("unhandledRejection", listener);

            return reasons;
        },
    };
}

// Lets every promise chain the spec started run to its end: the runner goes through several awaits
// between a free slot and the start of the next handler.
async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function update(updateId: number): ClaimedInboxUpdate {
    return {
        ...messageInput(updateId, USER, 5_000_000_000 + updateId),
        updateId: updateId,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        startedAt: "2026-10-07T10:01:00.000000+00:00",
        worker: WORKER,
        earlierAttempts: 0,
    };
}
