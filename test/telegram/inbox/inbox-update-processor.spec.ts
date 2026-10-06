import { mock } from "node:test";
import { expect } from "chai";
import { BotError } from "grammy";
import type { Update } from "@grammyjs/types";
import type { Bot } from "app/telegram/bot/bot";
import type { Context } from "app/telegram/bot/bot.types";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import type { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import { InboxUpdateProcessor } from "app/telegram/inbox/inbox-update-processor";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxLease, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

const USER = 5_000_000_001;
const CHAT = 5_000_000_001;
const WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
// The lease is extended every third of it.
const LEASE_DURATION_MS = 3_000;
const EXTENSION_INTERVAL_MS = 1_000;

// grammY as the processor uses it. init() and handleUpdate() each finish at once, unless the spec
// holds them; a held init() throws once its signal aborts, as grammY's retries of getMe end.
class FakeGrammy {
    public readonly handledUpdates: Update[] = [];
    public initCount = 0;
    public initSignals: AbortSignal[] = [];
    public initError: unknown = undefined;
    public handlerError: unknown = undefined;
    public heldInit: PromiseWithResolvers<void> | undefined;
    public heldHandler: PromiseWithResolvers<void> | undefined;

    public async init(signal: AbortSignal): Promise<void> {
        this.initCount += 1;
        this.initSignals.push(signal);

        if (this.heldInit !== undefined) {
            const heldInit = this.heldInit;
            signal.addEventListener("abort", () => heldInit.reject(new Error("Aborted delay")));

            await heldInit.promise;
        }

        if (this.initError !== undefined) {
            throw this.initError;
        }
    }

    public async handleUpdate(update: Update): Promise<void> {
        this.handledUpdates.push(update);

        if (this.heldHandler !== undefined) {
            await this.heldHandler.promise;
        }

        if (this.handlerError !== undefined) {
            throw this.handlerError;
        }
    }
}

// extendLease() answers isExtended, or throws extensionError; each call can be held.
class RecordingStore {
    public readonly done: InboxLease[] = [];
    public readonly extensions: InboxLease[] = [];
    public isExtended = true;
    public extensionError: unknown = undefined;
    public heldExtension: PromiseWithResolvers<void> | undefined;

    public async markAsDone(lease: InboxLease): Promise<void> {
        this.done.push(lease);
    }

    public async extendLease(lease: InboxLease): Promise<boolean> {
        this.extensions.push(lease);

        if (this.heldExtension !== undefined) {
            await this.heldExtension.promise;
        }

        if (this.extensionError !== undefined) {
            throw this.extensionError;
        }

        return this.isExtended;
    }
}

class RecordingFailureHandler {
    public readonly calls: { update: ClaimedInboxUpdate; error: unknown }[] = [];

    public async handle(update: ClaimedInboxUpdate, error: unknown): Promise<void> {
        this.calls.push({ update, error });
    }
}

class RecordingLeaseReleaser {
    public readonly released: InboxLease[] = [];

    public async releaseOnStop(lease: InboxLease): Promise<void> {
        this.released.push(lease);
    }
}

describe("InboxUpdateProcessor", function () {
    let grammy: FakeGrammy;
    let store: RecordingStore;
    let failureHandler: RecordingFailureHandler;
    let leaseReleaser: RecordingLeaseReleaser;
    let logger: RecordingLogger;
    let processor: InboxUpdateProcessor;
    let abortController: AbortController;

    beforeEach(function () {
        mock.timers.enable({ apis: ["setTimeout"] });
        grammy = new FakeGrammy();
        store = new RecordingStore();
        failureHandler = new RecordingFailureHandler();
        leaseReleaser = new RecordingLeaseReleaser();
        logger = new RecordingLogger();
        processor = new InboxUpdateProcessor(
            { grammy: grammy } as unknown as Bot,
            store as unknown as InboxStore,
            failureHandler as unknown as InboxFailureHandler,
            leaseReleaser as unknown as InboxLeaseReleaser,
            logger,
            LEASE_DURATION_MS,
        );
        abortController = new AbortController();
    });

    afterEach(function () {
        mock.timers.reset();
    });

    it("hands the update to the bot once it knows itself, and marks it done", async function () {
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(grammy.initCount).to.equal(1);
        expect(grammy.initSignals).to.deep.equal([abortController.signal]);
        expect(grammy.handledUpdates).to.deep.equal([update.update]);
        expect(store.done).to.deep.equal([update]);
        expect(failureHandler.calls).to.deep.equal([]);
        expect(leaseReleaser.released).to.deep.equal([]);
    });

    it("hands the error of a failed handler to the failure handler as grammY threw it", async function () {
        const error = new BotError(new Error("handler failed"), {} as Context);
        grammy.handlerError = error;
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(failureHandler.calls).to.have.lengthOf(1);
        expect(failureHandler.calls[0]?.update).to.equal(update);
        expect(failureHandler.calls[0]?.error).to.equal(error);
        expect(store.done).to.deep.equal([]);
        expect(leaseReleaser.released).to.deep.equal([]);
    });

    // Handled as a failure, an ordinary restart would block the group of every update in flight.
    it("releases an update whose handler a stopped outbox wait rejected, and does not fail it", async function () {
        grammy.handlerError = new BotError(OutboxResultWaiterStopped.of(7), {} as Context);
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(leaseReleaser.released).to.deep.equal([update]);
        expect(failureHandler.calls).to.deep.equal([]);
        expect(store.done).to.deep.equal([]);
    });

    it("releases a stopped outbox wait that reaches it unwrapped", async function () {
        grammy.handlerError = OutboxResultWaiterStopped.of(7);
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(leaseReleaser.released).to.deep.equal([update]);
        expect(failureHandler.calls).to.deep.equal([]);
    });

    it("releases without handling an update that comes with its signal aborted", async function () {
        abortController.abort();
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(grammy.handledUpdates).to.deep.equal([]);
        expect(leaseReleaser.released).to.deep.equal([update]);
        expect(failureHandler.calls).to.deep.equal([]);
        expect(store.done).to.deep.equal([]);
    });

    it("releases without handling an update whose init() the abort cut short", async function () {
        grammy.heldInit = Promise.withResolvers<void>();
        const update = claimedUpdate(1);
        const processed = processor.process(update, abortController.signal);
        await settle();

        abortController.abort();
        await processed;

        expect(grammy.handledUpdates).to.deep.equal([]);
        expect(leaseReleaser.released).to.deep.equal([update]);
        expect(failureHandler.calls).to.deep.equal([]);
    });

    it("releases without handling an update whose init() ended after the abort", async function () {
        const initDone = Promise.withResolvers<void>();
        grammy.init = (): Promise<void> => initDone.promise;
        const update = claimedUpdate(1);
        const processed = processor.process(update, abortController.signal);
        await settle();

        abortController.abort();
        initDone.resolve();
        await processed;

        expect(grammy.handledUpdates).to.deep.equal([]);
        expect(leaseReleaser.released).to.deep.equal([update]);
    });

    it("hands a failed init() to the failure handler", async function () {
        const error = new Error("401: Unauthorized");
        grammy.initError = error;
        const update = claimedUpdate(1);

        await processor.process(update, abortController.signal);

        expect(grammy.handledUpdates).to.deep.equal([]);
        expect(failureHandler.calls).to.deep.equal([{ update: update, error: error }]);
        expect(leaseReleaser.released).to.deep.equal([]);
    });

    it("extends the lease every third of it while the handler runs", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const update = claimedUpdate(1);
        const processed = processor.process(update, abortController.signal);

        await advance(EXTENSION_INTERVAL_MS - 1);
        expect(store.extensions).to.have.lengthOf(0);

        await advance(1);
        expect(store.extensions).to.deep.equal([update]);

        await advance(EXTENSION_INTERVAL_MS);
        expect(store.extensions).to.have.lengthOf(2);

        grammy.heldHandler.resolve();
        await processed;
    });

    it("stops extending the lease once the update has settled", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const processed = processor.process(claimedUpdate(1), abortController.signal);
        await advance(EXTENSION_INTERVAL_MS);

        grammy.heldHandler.resolve();
        await processed;
        await advance(3 * EXTENSION_INTERVAL_MS);

        expect(store.extensions).to.have.lengthOf(1);
    });

    // The stop has given the update up, and the database is closed after the stop.
    it("stops extending the lease on the abort, with the handler still running", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const processed = processor.process(claimedUpdate(1), abortController.signal);
        await advance(EXTENSION_INTERVAL_MS);

        abortController.abort();
        await advance(3 * EXTENSION_INTERVAL_MS);

        expect(store.extensions).to.have.lengthOf(1);
        grammy.heldHandler.resolve();
        await processed;
    });

    it("does not extend the lease of an update that comes with its signal aborted", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        abortController.abort();
        const processed = processor.process(claimedUpdate(1), abortController.signal);

        await advance(3 * EXTENSION_INTERVAL_MS);

        expect(store.extensions).to.deep.equal([]);
        grammy.heldHandler.resolve();
        await processed;
    });

    it("stops extending a lease that was refused, and logs it", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        store.isExtended = false;
        const processed = processor.process(claimedUpdate(1), abortController.signal);

        await advance(3 * EXTENSION_INTERVAL_MS);

        expect(store.extensions).to.have.lengthOf(1);
        expect(logger.warnings).to.deep.equal([
            {
                message: "The lease of an inbox update was not extended: it has passed or gone to another claim.",
                payload: { updateId: 1 },
            },
        ]);
        grammy.heldHandler.resolve();
        await processed;
    });

    it("goes on extending after a failed extension, and logs it", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const error = new Error("connection lost");
        store.extensionError = error;
        const processed = processor.process(claimedUpdate(1), abortController.signal);

        await advance(EXTENSION_INTERVAL_MS);
        store.extensionError = undefined;
        await advance(EXTENSION_INTERVAL_MS);

        expect(store.extensions).to.have.lengthOf(2);
        expect(logger.warnings).to.deep.equal([
            {
                message: "Extending the lease of an inbox update failed, the next extension tries again.",
                payload: { updateId: 1, cause: error },
            },
        ]);
        grammy.heldHandler.resolve();
        await processed;
    });

    // The completion ends the lease, so an extension it overtakes is refused.
    it("does not log a refusal of an extension the update settled during", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const processed = processor.process(claimedUpdate(1), abortController.signal);
        store.heldExtension = Promise.withResolvers<void>();
        await advance(EXTENSION_INTERVAL_MS);

        grammy.heldHandler.resolve();
        await processed;
        store.isExtended = false;
        store.heldExtension.resolve();
        await settle();

        expect(logger.warnings).to.deep.equal([]);
    });

    it("does not log a failed extension the update settled during", async function () {
        grammy.heldHandler = Promise.withResolvers<void>();
        const processed = processor.process(claimedUpdate(1), abortController.signal);
        store.heldExtension = Promise.withResolvers<void>();
        await advance(EXTENSION_INTERVAL_MS);

        grammy.heldHandler.resolve();
        await processed;
        store.extensionError = new Error("database closed");
        store.heldExtension.resolve();
        await advance(3 * EXTENSION_INTERVAL_MS);

        expect(logger.warnings).to.deep.equal([]);
        expect(store.extensions).to.have.lengthOf(1);
    });
});

function claimedUpdate(updateId: number): ClaimedInboxUpdate {
    return {
        ...messageInput(updateId, USER, CHAT),
        updateId: updateId,
        lockToken: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-10-07T00:00:00.000000+00:00",
        worker: WORKER,
        earlierAttempts: 0,
    };
}

// Lets every pending promise run: setImmediate is not faked, and it runs after the microtasks.
async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

async function advance(durationMs: number): Promise<void> {
    await settle();
    mock.timers.tick(durationMs);
    await settle();
}
