import { mock } from "node:test";
import { expect } from "chai";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The pull of the source over the real store is checked in outbox-store.spec.ts.

const CHAT = 5_000_000_001;
const WORKER: OutboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
// A random of 0.5 puts the cap of a sleep in the middle of 100 ms to 1 s.
const HALF_RANDOM = 0.5;
const HALF_CAP_MS = 550;
const MIN_CAP_MS = 100;
// The largest value Math.random returns, the largest double below 1: the cap rounds to the whole
// 1 s in floating point, as in outbox-retry-delay.spec.ts.
const LARGEST_RANDOM = 1 - Number.EPSILON / 2;
const MAX_CAP_MS = 1_000;
const NEXT_PULL_IN_MS = 200;
// Beyond the 2^31 - 1 ms a Node timer takes: Node would fire such a timer after 1 ms.
const BEYOND_TIMER_MS = 2 ** 31;
const NOTHING_READY: OutboxPullResult = { messages: [], nextPullInMs: null };

type LogRecord = { message: string; payload: UnknownObject | undefined };

class RecordingLogger implements Logger {
    public readonly errors: LogRecord[] = [];
    public readonly warnings: LogRecord[] = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(message: string, payload?: UnknownObject): void {
        this.warnings.push({ message: message, payload: payload });
    }

    public info(): void {}

    public debug(): void {}
}

// Answers the pulls from a queue of results, NOTHING_READY once it is empty. A pull can be held
// until the spec settles it.
class FakeStore {
    public readonly pulls: { limit: number; worker: OutboxWorker }[] = [];
    public listenCount = 0;
    public shouldFailListening = false;
    public readonly listeningFailure = new Error("connection refused");
    private readonly results: (OutboxPullResult | Error)[] = [];
    private heldPull: PromiseWithResolvers<OutboxPullResult> | undefined;
    private heldListening: PromiseWithResolvers<void> | undefined;
    private onReady: (() => void) | undefined;

    public answer(...results: (OutboxPullResult | Error)[]): void {
        this.results.push(...results);
    }

    // The next pull waits for release().
    public hold(): void {
        this.heldPull = Promise.withResolvers<OutboxPullResult>();
    }

    public release(result: OutboxPullResult): void {
        this.heldPull?.resolve(result);
        this.heldPull = undefined;
    }

    public fail(error: Error): void {
        this.heldPull?.reject(error);
        this.heldPull = undefined;
    }

    // A notification, or a start of the listening after a reconnect: postgres.js calls onReady on
    // both.
    public notifyReady(): void {
        this.onReady?.();
    }

    public async pull(limit: number, worker: OutboxWorker): Promise<OutboxPullResult> {
        this.pulls.push({ limit: limit, worker: worker });

        if (this.heldPull !== undefined) {
            return this.heldPull.promise;
        }

        const result = this.results.shift() ?? NOTHING_READY;

        if (result instanceof Error) {
            throw result;
        }

        return result;
    }

    // The next start of the listening waits for startListening() or failListening().
    public holdListening(): void {
        this.heldListening = Promise.withResolvers<void>();
    }

    public startListening(): void {
        this.heldListening?.resolve();
    }

    public failListening(error: Error): void {
        this.heldListening?.reject(error);
    }

    public async listenReady(onReady: () => void): Promise<void> {
        this.listenCount += 1;

        if (this.shouldFailListening) {
            throw this.listeningFailure;
        }

        // Awaited only when held: an await of nothing would still put the start after the first
        // pull of the generator, and the start would make every spec pull twice.
        if (this.heldListening !== undefined) {
            await this.heldListening.promise;
        }

        this.onReady = onReady;
        onReady();
    }
}

describe("OutboxMessageSource", function () {
    let store: FakeStore;
    let logger: RecordingLogger;

    beforeEach(function () {
        mock.timers.enable({ apis: ["setTimeout"] });
        store = new FakeStore();
        logger = new RecordingLogger();
    });

    afterEach(function () {
        mock.timers.reset();
    });

    it("pulls one message for the worker loop", async function () {
        const message = pulledMessage(1);
        store.answer(pullOf(message));

        const next = await build().stream(WORKER).next();

        expect(next.value).to.deep.equal(message);
        expect(store.pulls).to.deep.equal([{ limit: 1, worker: WORKER }]);
    });

    it("pulls again only when the loop asks for the next message", async function () {
        store.answer(pullOf(pulledMessage(1)), pullOf(pulledMessage(2)));
        const stream = build().stream(WORKER);

        await stream.next();
        await settle();
        expect(store.pulls).to.have.length(1);

        expect((await stream.next()).value).to.deep.equal(pulledMessage(2));
        expect(store.pulls).to.have.length(2);
    });

    it("sleeps until nextPullInMs when it comes before the cap", async function () {
        store.answer({ messages: [], nextPullInMs: NEXT_PULL_IN_MS });
        void build().stream(WORKER).next();

        await advance(NEXT_PULL_IN_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("caps the sleep by a random point from 100 ms to 1 s", async function () {
        store.answer({ messages: [], nextPullInMs: MAX_CAP_MS });
        void build().stream(WORKER).next();

        await advance(HALF_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("takes the lower end of the cap for the lowest random", async function () {
        store.answer({ messages: [], nextPullInMs: MAX_CAP_MS });
        void build(() => 0)
            .stream(WORKER)
            .next();

        await advance(MIN_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("takes the upper end of the cap for the highest random", async function () {
        store.answer({ messages: [], nextPullInMs: BEYOND_TIMER_MS });
        void build(() => LARGEST_RANDOM)
            .stream(WORKER)
            .next();

        await advance(MAX_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("sleeps within the cap on a nextPullInMs beyond a Node timer", async function () {
        store.answer({ messages: [], nextPullInMs: BEYOND_TIMER_MS });
        void build().stream(WORKER).next();

        await advance(1);
        expect(store.pulls).to.have.length(1);

        await advance(HALF_CAP_MS - 1);
        expect(store.pulls).to.have.length(2);
    });

    it("sleeps the whole cap when no chat is ready", async function () {
        store.answer(NOTHING_READY);
        void build().stream(WORKER).next();

        await advance(HALF_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    // Another transaction holds a due chat, or the pull waited behind a slow holder of the bot row:
    // pulling again at once would spin in the first case.
    it("sleeps the whole cap on a nextPullInMs of zero with nothing pulled", async function () {
        store.answer({ messages: [], nextPullInMs: 0 });
        void build().stream(WORKER).next();

        await advance(HALF_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("wakes up at once on a ready notification", async function () {
        const message = pulledMessage(1);
        store.answer(NOTHING_READY, pullOf(message));
        const next = build().stream(WORKER).next();
        await settle();

        store.notifyReady();

        expect((await next).value).to.deep.equal(message);
        expect(store.pulls).to.have.length(2);
    });

    // The pull may have read the tables before the push it announces committed.
    it("pulls again at once after a notification that came during a pull", async function () {
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.notifyReady();
        store.release(NOTHING_READY);
        await settle();

        expect(store.pulls).to.have.length(2);
    });

    // The first pull may have read the tables before the LISTEN, and a push in between was heard by
    // no one.
    it("pulls again at once when the listening starts during the first pull", async function () {
        store.holdListening();
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.startListening();
        await settle();
        store.release(NOTHING_READY);
        await settle();

        expect(store.pulls).to.have.length(2);
    });

    it("does not log a start of the listening that fails after stop", async function () {
        store.holdListening();
        const source = build();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();
        store.failListening(new Error("database closed"));
        await settle();

        expect(await next).to.deep.equal({ value: undefined, done: true });
        expect(logger.warnings).to.be.empty;
    });

    it("listens once across the pulls and the sleeps of the generator", async function () {
        store.answer(NOTHING_READY, pullOf(pulledMessage(1)));
        const stream = build().stream(WORKER);
        const next = stream.next();

        await advance(HALF_CAP_MS);
        await next;
        void stream.next();
        await settle();

        expect(store.pulls).to.have.length(3);
        expect(store.listenCount).to.equal(1);
    });

    it("goes on with the capped sleep when the listening fails", async function () {
        store.shouldFailListening = true;
        void build().stream(WORKER).next();
        await settle();

        expect(logger.warnings).to.deep.equal([
            {
                message: "Listening for ready outbox messages failed, the source pulls on the capped sleep until the listening starts.",
                payload: { cause: store.listeningFailure },
            },
        ]);

        await advance(HALF_CAP_MS);
        expect(store.pulls).to.have.length(2);
    });

    it("logs a failed pull and pulls again after the cap", async function () {
        const failure = new Error("connection lost");
        const message = pulledMessage(1);
        store.answer(failure, pullOf(message));
        const next = build().stream(WORKER).next();
        await settle();

        expect(logger.errors).to.deep.equal([
            {
                message: "Pulling outbox messages failed, the next pull tries again.",
                payload: { worker: WORKER, cause: failure },
            },
        ]);

        await advance(HALF_CAP_MS);
        expect((await next).value).to.deep.equal(message);
    });

    it("sleeps the whole cap after a failed pull, with notifications during the pull and the sleep", async function () {
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.notifyReady();
        store.fail(new Error("connection lost"));
        await settle();
        store.notifyReady();

        await advance(HALF_CAP_MS - 1);
        expect(store.pulls).to.have.length(1);

        await advance(1);
        expect(store.pulls).to.have.length(2);
    });

    it("ends a generator sleeping after a failed pull at once on stop", async function () {
        const source = build();
        store.answer(new Error("connection lost"));
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();

        expect(await next).to.deep.equal({ value: undefined, done: true });
    });

    it("ends a sleeping generator at once on stop", async function () {
        const source = build();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();

        expect(await next).to.deep.equal({ value: undefined, done: true });
        expect(store.pulls).to.have.length(1);
    });

    it("leaves no timer behind when stop cuts a sleep short", async function () {
        // On real timers: a timer left running would hold the process for up to a second after the shutdown.
        // Counted against the sleep rather than the start: the runtime may hold timers of its own.
        mock.timers.reset();
        const source = build();
        const next = source.stream(WORKER).next();
        await settle();
        const timerCountAsleep = activeTimerCount();

        source.stop();
        await next;

        expect(activeTimerCount()).to.equal(timerCountAsleep - 1);
    });

    it("hands out the message of a pull in progress on stop, then ends", async function () {
        const source = build();
        const stream = source.stream(WORKER);
        const message = pulledMessage(1);
        store.hold();
        const next = stream.next();
        await settle();

        source.stop();
        store.release(pullOf(message));

        expect((await next).value).to.deep.equal(message);
        expect(await stream.next()).to.deep.equal({ value: undefined, done: true });
        expect(store.pulls).to.have.length(1);
    });

    it("ends without a sleep when a pull in progress on stop got nothing", async function () {
        const source = build();
        store.hold();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();
        store.release(NOTHING_READY);

        expect(await next).to.deep.equal({ value: undefined, done: true });
    });

    it("ends a generator waiting for the loop at the next message", async function () {
        const source = build();
        store.answer(pullOf(pulledMessage(1)));
        const stream = source.stream(WORKER);
        await stream.next();

        source.stop();

        expect(await stream.next()).to.deep.equal({ value: undefined, done: true });
        expect(store.pulls).to.have.length(1);
    });

    it("ends a generator made after stop without a pull", async function () {
        const source = build();
        source.stop();

        expect(await source.stream(WORKER).next()).to.deep.equal({ value: undefined, done: true });
        expect(store.pulls).to.be.empty;
        expect(store.listenCount).to.equal(0);
    });

    it("logs a pull that fails after stop as a warning, not as an error to retry", async function () {
        const source = build();
        const failure = new Error("database closed");
        store.hold();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();
        store.fail(failure);

        expect(await next).to.deep.equal({ value: undefined, done: true });
        expect(logger.errors).to.be.empty;
        expect(logger.warnings).to.deep.equal([
            { message: "Pulling outbox messages failed after the stop.", payload: { worker: WORKER, cause: failure } },
        ]);
    });

    function build(random: () => number = () => HALF_RANDOM): OutboxMessageSource {
        return new OutboxMessageSource(store as unknown as OutboxStore, logger, random);
    }
});

function pulledMessage(id: number): PulledOutboxMessage {
    return {
        id: id,
        chatId: CHAT,
        method: "sendMessage",
        payload: { chat_id: CHAT, text: `message ${id}` },
        priority: 0,
        lockToken: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-09-30T00:00:00.000000+00:00",
        worker: WORKER,
        earlierAttempts: 0,
    };
}

// The answer of a pull that got message.
function pullOf(message: PulledOutboxMessage): OutboxPullResult {
    return { messages: [message], nextPullInMs: 0 };
}

function activeTimerCount(): number {
    return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
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
