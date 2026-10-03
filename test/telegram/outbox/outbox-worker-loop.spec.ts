import { expect } from "chai";
import { HttpError } from "grammy";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import type { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import type { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { OutboxWorkerLoop } from "app/telegram/outbox/outbox-worker-loop";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type {
    OutboxAttemptError,
    OutboxJson,
    OutboxLease,
    OutboxRetryOptions,
    OutboxWorker,
    PulledOutboxMessage,
} from "app/telegram/outbox/store/outbox-store.types";

const WORKER: OutboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
const CONCURRENCY = 2;
// Longer than any spec waits: a stop that reaches it has aborted a call it should have waited for.
const LONG_STOP_TIMEOUT_MS = 10_000;
const SHORT_STOP_TIMEOUT_MS = 50;
// setTimeout() may fire a little before its delay on some platforms.
const TIMER_TOLERANCE_MS = 5;

// Hands out the messages put into it, one per next(), and waits for more when it has none. Ends on
// stop(), as the real source does from a sleep.
class FakeSource {
    public readonly workers: OutboxWorker[] = [];
    public readonly waiting: PulledOutboxMessage[] = [];
    public isStopped = false;
    private wakeUp: (() => void) | undefined;

    public add(...messages: PulledOutboxMessage[]): void {
        this.waiting.push(...messages);
        this.wakeUp?.();
    }

    public async *stream(worker: OutboxWorker): AsyncGenerator<PulledOutboxMessage, void, undefined> {
        this.workers.push(worker);

        while (!this.isStopped) {
            const message = this.waiting.shift();

            if (message !== undefined) {
                yield message;
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
    message: PulledOutboxMessage;
    signal: AbortSignal;
    finish: () => void;
    fail: (error: unknown) => void;
};

// Each call runs until the spec finishes or fails it. With settlesOnAbort, an abort settles the call
// as the real processor does once it has released the message.
class FakeProcessor {
    public readonly calls: ProcessCall[] = [];
    public settlesOnAbort = true;

    public process(message: PulledOutboxMessage, signal: AbortSignal): Promise<void> {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const call: ProcessCall = {
            message,
            signal,
            finish: () => resolve(),
            fail: (error: unknown) => reject(error),
        };

        // A signal aborted before the call settles it at once, as grammY fails such a call before it
        // sends it.
        if (signal.aborted && this.settlesOnAbort) {
            call.finish();
        }

        signal.addEventListener("abort", () => {
            if (this.settlesOnAbort) {
                call.finish();
            }
        });
        this.calls.push(call);

        return promise;
    }
}

// Runs until its call is aborted, then throws as grammY throws an aborted fetch.
class HangingSender {
    public send(_method: string, _payload: Record<string, unknown>, signal: AbortSignal): Promise<OutboxJson> {
        return new Promise<OutboxJson>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
                reject(new HttpError("Network request for 'sendMessage' failed!", new Error("The operation was aborted.")));
            });
        });
    }
}

type Retry = { lease: OutboxLease; attemptError: OutboxAttemptError; delayMs: number; options: OutboxRetryOptions | undefined };

class RetryRecordingStore {
    public readonly retries: Retry[] = [];
    public readonly done: OutboxLease[] = [];

    public async retry(lease: OutboxLease, attemptError: OutboxAttemptError, delayMs: number, options?: OutboxRetryOptions): Promise<void> {
        this.retries.push({ lease, attemptError, delayMs, options });
    }

    public async markAsDone(lease: OutboxLease): Promise<boolean> {
        this.done.push(lease);

        return true;
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

describe("OutboxWorkerLoop", function () {
    let source: FakeSource;
    let processor: FakeProcessor;
    let logger: RecordingLogger;

    beforeEach(function () {
        source = new FakeSource();
        processor = new FakeProcessor();
        logger = new RecordingLogger();
    });

    it("takes the messages of its own worker from the source", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);

        loop.start();
        await settle();

        expect(source.workers).to.deep.equal([WORKER]);
        await loop.stop();
    });

    it("sends as many messages at once as it has slots and leaves the rest in the source", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        source.add(message(1), message(2), message(3));

        loop.start();
        await settle();

        expect(processor.calls.map((call) => call.message.id)).to.deep.equal([1, 2]);
        expect(source.waiting.map((waiting) => waiting.id)).to.deep.equal([3]);
        await stopFinishingCalls(loop);
    });

    it("takes the next message once a slot is free", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        source.add(message(1), message(2), message(3));
        loop.start();
        await settle();

        processor.calls[1]?.finish();
        await settle();

        expect(processor.calls.map((call) => call.message.id)).to.deep.equal([1, 2, 3]);
        await stopFinishingCalls(loop);
    });

    it("takes a message added while it waits for one", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        loop.start();
        await settle();

        source.add(message(1));
        await settle();

        expect(processor.calls.map((call) => call.message.id)).to.deep.equal([1]);
        await stopFinishingCalls(loop);
    });

    it("logs a message that was not completed and frees its slot", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        const error = new Error("connection lost");
        source.add(message(1), message(2), message(3));
        loop.start();
        await settle();

        processor.calls[0]?.fail(error);
        await settle();

        expect(logger.errors).to.deep.equal([
            {
                message: "An outbox message was not completed, the recovery of its lease takes it back.",
                payload: { messageId: 1, cause: error },
            },
        ]);
        expect(processor.calls.map((call) => call.message.id)).to.deep.equal([1, 2, 3]);
        await stopFinishingCalls(loop);
    });

    it("stops the source on stop", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        loop.start();

        await loop.stop();

        expect(source.isStopped).to.equal(true);
    });

    it("takes no message after the stop while every slot is busy", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        source.add(message(1), message(2));
        loop.start();
        await settle();

        const stopped = loop.stop();
        source.add(message(3));
        processor.calls[0]?.finish();
        processor.calls[1]?.finish();
        await stopped;

        expect(processor.calls.map((call) => call.message.id)).to.deep.equal([1, 2]);
    });

    it("waits for the calls in flight and aborts none that finish before the deadline", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);
        source.add(message(1), message(2));
        loop.start();
        await settle();

        let isStopped = false;
        const stopped = loop.stop().then(() => {
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
    });

    it("aborts the calls still in flight at the deadline and leaves the finished ones alone", async function () {
        const loop = createLoop(SHORT_STOP_TIMEOUT_MS);
        source.add(message(1), message(2), message(3));
        loop.start();
        await settle();
        processor.calls[0]?.finish();
        await settle();
        const startedAt = Date.now();

        await loop.stop();

        expect(Date.now() - startedAt).to.be.at.least(SHORT_STOP_TIMEOUT_MS - TIMER_TOLERANCE_MS);
        expect(processor.calls.map((call) => [call.message.id, call.signal.aborted])).to.deep.equal([
            [1, false],
            [2, true],
            [3, true],
        ]);
    });

    it("aborts the calls in flight at once with a deadline of zero", async function () {
        const loop = createLoop(0);
        source.add(message(1));
        loop.start();
        await settle();

        await loop.stop();

        expect(processor.calls.map((call) => call.signal.aborted)).to.deep.equal([true]);
    });

    it("waits until an aborted call settles before the stop ends", async function () {
        const loop = createLoop(0);
        processor.settlesOnAbort = false;
        source.add(message(1));
        loop.start();
        await settle();

        let isStopped = false;
        const stopped = loop.stop().then(() => {
            isStopped = true;
        });
        await waitForAbort(processor.calls[0]);
        await settle();

        expect(isStopped).to.equal(false);
        processor.calls[0]?.finish();
        await stopped;
        expect(isStopped).to.equal(true);
    });

    // The source ends a generator whose pull is in progress only once it has handed out what the
    // pull got: left unsent, the message would wait for the recovery of its lease.
    it("sends the message a pull in progress hands out after the stop", async function () {
        const { loop, pull } = createLoopOverPullInProgress(LONG_STOP_TIMEOUT_MS);
        loop.start();
        await settle();

        const stopped = loop.stop();
        pull.resolve(message(1));
        await settle();

        expect(processor.calls.map((call) => [call.message.id, call.signal.aborted])).to.deep.equal([[1, false]]);
        processor.calls[0]?.finish();
        await stopped;
    });

    // The real processor and failure handler over a fake store: what reaches the outbox of a call
    // the deadline cut short.
    it("releases the message of a call aborted at the deadline with no retry delay and wakes the idle nodes", async function () {
        const store = new RetryRecordingStore();
        const failureHandler = new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            new OutboxRetryDelay({ firstDelayMs: 1_000, maxDelayMs: 60_000, multiplier: 2 }, () => 0),
            new OutboxErrorSerializer("token"),
            logger,
            10,
        );
        const realProcessor = new OutboxMessageProcessor(
            new HangingSender() as unknown as OutboxSender,
            store as unknown as OutboxStore,
            failureHandler,
            logger,
        );
        const loop = new OutboxWorkerLoop(
            source as unknown as OutboxMessageSource,
            realProcessor,
            logger,
            CONCURRENCY,
            SHORT_STOP_TIMEOUT_MS,
            WORKER,
        );
        const pulled = message(1);
        source.add(pulled);
        loop.start();
        await settle();

        await loop.stop();

        expect(store.retries).to.have.lengthOf(1);
        expect(store.retries[0]?.lease).to.equal(pulled);
        expect(store.retries[0]?.attemptError).to.include({ name: "OutboxNodeStopped", kind: TelegramBotApiFailureKind.Transient });
        expect(store.retries[0]?.delayMs).to.equal(0);
        expect(store.retries[0]?.options).to.deep.equal({ shouldWakeIdleNodes: true });
        expect(store.done).to.deep.equal([]);
    });

    it("starts aborted the message a pull in progress hands out after the deadline", async function () {
        const { loop, pull } = createLoopOverPullInProgress(0);
        loop.start();
        await settle();

        const stopped = loop.stop();
        pull.resolve(message(1));
        await settle();

        expect(processor.calls.map((call) => [call.message.id, call.signal.aborted])).to.deep.equal([[1, true]]);
        await stopped;
    });

    it("stops before it was started", async function () {
        const loop = createLoop(LONG_STOP_TIMEOUT_MS);

        await loop.stop();

        expect(source.isStopped).to.equal(true);
        expect(processor.calls).to.deep.equal([]);
    });

    function createLoop(stopTimeoutMs: number): OutboxWorkerLoop {
        return new OutboxWorkerLoop(
            source as unknown as OutboxMessageSource,
            processor as unknown as OutboxMessageProcessor,
            logger,
            CONCURRENCY,
            stopTimeoutMs,
            WORKER,
        );
    }

    // A loop over a source whose one pull is in progress until the spec resolves pull: the source
    // hands out what the pull got even after its stop.
    function createLoopOverPullInProgress(stopTimeoutMs: number): {
        loop: OutboxWorkerLoop;
        pull: PromiseWithResolvers<PulledOutboxMessage>;
    } {
        const pull = Promise.withResolvers<PulledOutboxMessage>();
        const pullingSource = {
            async *stream(): AsyncGenerator<PulledOutboxMessage, void, undefined> {
                yield await pull.promise;
            },
            stop(): void {},
        };
        const loop = new OutboxWorkerLoop(
            pullingSource as unknown as OutboxMessageSource,
            processor as unknown as OutboxMessageProcessor,
            logger,
            CONCURRENCY,
            stopTimeoutMs,
            WORKER,
        );

        return { loop, pull };
    }

    // Stops the loop and finishes the calls in flight, so the stop has no deadline to wait for.
    async function stopFinishingCalls(loop: OutboxWorkerLoop): Promise<void> {
        const stopped = loop.stop();

        for (const call of processor.calls) {
            call.finish();
        }

        await stopped;
    }
});

// Lets every promise chain the spec started run to its end: the loop goes through several awaits
// between a free slot and the start of the next call.
async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForAbort(call: ProcessCall | undefined): Promise<void> {
    if (call === undefined) {
        expect.fail("the call was expected to have started");
    }

    if (call.signal.aborted) {
        return;
    }

    await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve()));
}

function message(id: number): PulledOutboxMessage {
    return {
        id,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        startedAt: "2026-09-30T10:01:00.000000+00:00",
        worker: WORKER,
        chatId: 5_000_000_000 + id,
        method: "sendMessage",
        payload: { chat_id: 5_000_000_000 + id, text: `message ${id}` },
        priority: 0,
        earlierAttempts: 0,
    };
}
