import { mock } from "node:test";
import { expect } from "chai";
import { InboxUpdateSource } from "app/telegram/inbox/inbox-update-source";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

// The claim of the source over the real store is checked in inbox-store.spec.ts and
// inbox-runner.database.spec.ts.

const USER = 5_000_000_001;
const CHAT = 5_000_000_001;
const WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
// A random of 0.5 puts the sleep in the middle of 100 ms to 1 s.
const HALF_RANDOM = 0.5;
const HALF_SLEEP_MS = 550;
const MIN_SLEEP_MS = 100;
// The largest value Math.random returns, the largest double below 1: the sleep rounds to the whole
// 1 s in floating point, as in outbox-retry-delay.spec.ts.
const LARGEST_RANDOM = 1 - Number.EPSILON / 2;
const MAX_SLEEP_MS = 1_000;

// Answers the claims from a queue of results, nothing once it is empty. A claim can be held until the
// spec settles it.
class FakeStore {
    public readonly claims: { limit: number; worker: InboxWorker }[] = [];
    public listenCount = 0;
    public shouldFailListening = false;
    public readonly listeningFailure = new Error("connection refused");
    private readonly results: (ClaimedInboxUpdate[] | Error)[] = [];
    private heldClaim: PromiseWithResolvers<ClaimedInboxUpdate[]> | undefined;
    private heldListening: PromiseWithResolvers<void> | undefined;
    private onReady: (() => void) | undefined;

    public answer(...results: (ClaimedInboxUpdate[] | Error)[]): void {
        this.results.push(...results);
    }

    // The next claim waits for release().
    public hold(): void {
        this.heldClaim = Promise.withResolvers<ClaimedInboxUpdate[]>();
    }

    public release(result: ClaimedInboxUpdate[]): void {
        this.heldClaim?.resolve(result);
        this.heldClaim = undefined;
    }

    public fail(error: Error): void {
        this.heldClaim?.reject(error);
        this.heldClaim = undefined;
    }

    // A notification, or a start of the listening after a reconnect: postgres.js calls onReady on
    // both.
    public notifyReady(): void {
        this.onReady?.();
    }

    public async claim(limit: number, worker: InboxWorker): Promise<ClaimedInboxUpdate[]> {
        this.claims.push({ limit: limit, worker: worker });

        if (this.heldClaim !== undefined) {
            return this.heldClaim.promise;
        }

        const result = this.results.shift() ?? [];

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
        // claim of the generator, and the start would make every spec claim twice.
        if (this.heldListening !== undefined) {
            await this.heldListening.promise;
        }

        this.onReady = onReady;
        onReady();
    }
}

describe("InboxUpdateSource", function () {
    let store: FakeStore;
    let logger: RecordingLogger;

    beforeEach(function () {
        mock.timers.enable({ apis: ["setTimeout"] });
        store = new FakeStore();
        logger = new RecordingLogger();
    });

    afterEach(function () {
        mock.restoreAll();
        mock.timers.reset();
    });

    it("claims one update for the runner", async function () {
        const update = claimedUpdate(1);
        store.answer([update]);

        const next = await build().stream(WORKER).next();

        expect(next.value).to.deep.equal(update);
        expect(store.claims).to.deep.equal([{ limit: 1, worker: WORKER }]);
    });

    it("claims again only when the loop asks for the next update", async function () {
        store.answer([claimedUpdate(1)], [claimedUpdate(2)]);
        const stream = build().stream(WORKER);

        await stream.next();
        await settle();
        expect(store.claims).to.have.length(1);

        expect((await stream.next()).value).to.deep.equal(claimedUpdate(2));
        expect(store.claims).to.have.length(2);
    });

    // A claim of one never gets more, but a source that stopped after the first would leave the rest
    // claimed by nobody.
    it("hands out every update a claim got, one per ask", async function () {
        store.answer([claimedUpdate(1), claimedUpdate(2)]);
        const stream = build().stream(WORKER);

        expect((await stream.next()).value).to.deep.equal(claimedUpdate(1));
        expect((await stream.next()).value).to.deep.equal(claimedUpdate(2));
        expect(store.claims).to.have.length(1);
    });

    it("sleeps a random point from 100 ms to 1 s after a claim that got nothing", async function () {
        void build().stream(WORKER).next();

        await advance(HALF_SLEEP_MS - 1);
        expect(store.claims).to.have.length(1);

        await advance(1);
        expect(store.claims).to.have.length(2);
    });

    it("takes the lower end of the sleep for the lowest random", async function () {
        void build(() => 0)
            .stream(WORKER)
            .next();

        await advance(MIN_SLEEP_MS - 1);
        expect(store.claims).to.have.length(1);

        await advance(1);
        expect(store.claims).to.have.length(2);
    });

    it("takes the upper end of the sleep for the highest random", async function () {
        void build(() => LARGEST_RANDOM)
            .stream(WORKER)
            .next();

        await advance(MAX_SLEEP_MS - 1);
        expect(store.claims).to.have.length(1);

        await advance(1);
        expect(store.claims).to.have.length(2);
    });

    it("wakes up at once on a ready notification", async function () {
        const update = claimedUpdate(1);
        store.answer([], [update]);
        const next = build().stream(WORKER).next();
        await settle();

        store.notifyReady();

        expect((await next).value).to.deep.equal(update);
        expect(store.claims).to.have.length(2);
    });

    // The claim may have read the tables before the write it announces committed.
    it("claims again at once after a notification that came during a claim", async function () {
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.notifyReady();
        store.release([]);
        await settle();

        expect(store.claims).to.have.length(2);
    });

    // The first claim may have read the tables before the LISTEN, and a write in between was heard by
    // no one.
    it("claims again at once when the listening starts during the first claim", async function () {
        store.holdListening();
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.startListening();
        await settle();
        store.release([]);
        await settle();

        expect(store.claims).to.have.length(2);
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

    it("listens once across the claims and the sleeps of the generator", async function () {
        store.answer([], [claimedUpdate(1)]);
        const stream = build().stream(WORKER);
        const next = stream.next();

        await advance(HALF_SLEEP_MS);
        await next;
        void stream.next();
        await settle();

        expect(store.claims).to.have.length(3);
        expect(store.listenCount).to.equal(1);
    });

    it("goes on with the timed sleep when the listening fails", async function () {
        store.shouldFailListening = true;
        void build().stream(WORKER).next();
        await settle();

        expect(logger.warnings).to.deep.equal([
            {
                message: "Listening for ready inbox groups failed, the source claims on the timed sleep until the listening starts.",
                payload: { cause: store.listeningFailure },
            },
        ]);

        await advance(HALF_SLEEP_MS);
        expect(store.claims).to.have.length(2);
    });

    it("logs a failed claim and claims again after the sleep", async function () {
        const failure = new Error("connection lost");
        const update = claimedUpdate(1);
        store.answer(failure, [update]);
        const next = build().stream(WORKER).next();
        await settle();

        expect(logger.errors).to.deep.equal([
            {
                message: "Claiming inbox updates failed, the next claim tries again.",
                payload: { worker: WORKER, cause: failure },
            },
        ]);

        await advance(HALF_SLEEP_MS);
        expect((await next).value).to.deep.equal(update);
    });

    it("sleeps the whole time after a failed claim, with notifications during the claim and the sleep", async function () {
        store.hold();
        void build().stream(WORKER).next();
        await settle();

        store.notifyReady();
        store.fail(new Error("connection lost"));
        await settle();
        store.notifyReady();

        await advance(HALF_SLEEP_MS - 1);
        expect(store.claims).to.have.length(1);

        await advance(1);
        expect(store.claims).to.have.length(2);
    });

    it("ends a generator sleeping after a failed claim at once on stop", async function () {
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
        expect(store.claims).to.have.length(1);
    });

    it("clears the timer of a sleep that stop cuts short", async function () {
        // A timer left running would hold the process for up to a second after the shutdown.
        const setTimeoutMock = mock.method(globalThis, "setTimeout");
        const clearTimeoutMock = mock.method(globalThis, "clearTimeout");
        const source = build();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();
        await next;

        const timers = setTimeoutMock.mock.calls.map((call) => call.result);
        const clearedTimers = clearTimeoutMock.mock.calls.map((call) => call.arguments[0]);

        expect(timers).to.have.length(1);
        expect(clearedTimers).to.deep.equal(timers);
    });

    it("hands out the update of a claim in progress on stop, then ends", async function () {
        const source = build();
        const stream = source.stream(WORKER);
        const update = claimedUpdate(1);
        store.hold();
        const next = stream.next();
        await settle();

        source.stop();
        store.release([update]);

        expect((await next).value).to.deep.equal(update);
        expect(await stream.next()).to.deep.equal({ value: undefined, done: true });
        expect(store.claims).to.have.length(1);
    });

    it("ends without a sleep when a claim in progress on stop got nothing", async function () {
        const source = build();
        store.hold();
        const next = source.stream(WORKER).next();
        await settle();

        source.stop();
        store.release([]);

        expect(await next).to.deep.equal({ value: undefined, done: true });
    });

    it("ends a generator waiting for the loop at the next update", async function () {
        const source = build();
        store.answer([claimedUpdate(1)]);
        const stream = source.stream(WORKER);
        await stream.next();

        source.stop();

        expect(await stream.next()).to.deep.equal({ value: undefined, done: true });
        expect(store.claims).to.have.length(1);
    });

    it("ends a generator made after stop without a claim", async function () {
        const source = build();
        source.stop();

        expect(await source.stream(WORKER).next()).to.deep.equal({ value: undefined, done: true });
        expect(store.claims).to.be.empty;
        expect(store.listenCount).to.equal(0);
    });

    it("logs a claim that fails after stop as a warning, not as an error to retry", async function () {
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
            { message: "Claiming inbox updates failed after the stop.", payload: { worker: WORKER, cause: failure } },
        ]);
    });

    function build(random: () => number = () => HALF_RANDOM): InboxUpdateSource {
        return new InboxUpdateSource(store as unknown as InboxStore, logger, random);
    }
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
