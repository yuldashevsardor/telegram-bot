import { expect } from "chai";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { sleep } from "app/shared/utils";
import { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import { OutboxResultTimeout, OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import type { FinishedMessageSource, OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import type { FinishedOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";

// The waiter over the real store and database is checked in outbox-store.spec.ts.

// Longer than any passing test takes, shorter than the timeout of mocha: a timer of this length
// never fires in a passing test, and a wait that is never settled fails with its own error.
const NEVER_MS = 1_000;
const SOON_MS = 10;
// How long a test waits for something that must not happen.
const QUIET_MS = 50;
// A timeout two sleeps of 60% of it are measured against: wide enough to hold under the load of a
// mutation run.
const SHORT_TIMEOUT_MS = 200;
const SHORT_TIMEOUT_SHARE_MS = SHORT_TIMEOUT_MS * 0.6;

const MESSAGE: FinishedOutboxMessage = { id: 7, status: OutboxStatus.Done, response: { message_id: 1 } };
const OTHER_MESSAGE: FinishedOutboxMessage = { id: 8, status: OutboxStatus.Failed, response: null };

describe("OutboxResultWaiter", function () {
    this.timeout(2_000);

    it("resolves a wait by the notification of its message", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const result = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        source.notify(MESSAGE.id);

        expect(await result).to.deep.equal(MESSAGE);
        expect(source.lookups).to.deep.equal([[MESSAGE.id]]);
    });

    it("does not read a message nobody waits for on this node", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const result = waiter.wait(MESSAGE.id);
        source.notify(OTHER_MESSAGE.id);
        await sleep(QUIET_MS);

        expect(source.lookups).to.be.empty;

        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await result;
    });

    it("resolves a wait by the poll when no notification comes", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });

        const result = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);

        expect(await result).to.deep.equal(MESSAGE);
    });

    it("polls every id waited for in one lookup", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });

        const results = Promise.all([waiter.wait(MESSAGE.id), waiter.wait(OTHER_MESSAGE.id)]);
        source.finish(MESSAGE);
        source.finish(OTHER_MESSAGE);

        expect(await results).to.deep.equal([MESSAGE, OTHER_MESSAGE]);
        expect(source.lookups[0]).to.deep.equal([MESSAGE.id, OTHER_MESSAGE.id]);
    });

    it("keeps waiting for a message the poll finds unfinished", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });

        const result = waiter.wait(MESSAGE.id);
        await waitFor(() => source.lookups.length >= 2);
        source.finish(MESSAGE);

        expect(await result).to.deep.equal(MESSAGE);
    });

    // A message finished while the listening was being set up or restored has sent its
    // notification to nobody.
    it("polls when the listening starts", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const result = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        source.listenStarted();

        expect(await result).to.deep.equal(MESSAGE);
    });

    it("does not poll when nothing is waited for", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const result = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await result;
        const lookupCount = source.lookups.length;

        source.listenStarted();
        await sleep(QUIET_MS);

        expect(source.lookups).to.have.length(lookupCount);
    });

    it("keeps polling for a message after another one is settled", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });

        const pending = waiter.wait(OTHER_MESSAGE.id);
        const settled = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await settled;
        source.finish(OTHER_MESSAGE);

        expect(await pending).to.deep.equal(OTHER_MESSAGE);
    });

    it("leaves no timer behind once every wait is settled", async function () {
        const source = new FakeSource();
        const waiter = build(source);
        // mocha starts the timer of the test once the synchronous part of the test has returned.
        await Promise.resolve();
        const timerCount = activeTimerCount();

        const results = Promise.all([waiter.wait(MESSAGE.id), waiter.wait(OTHER_MESSAGE.id)]);
        source.finish(MESSAGE);
        source.finish(OTHER_MESSAGE);
        source.notify(MESSAGE.id);
        source.notify(OTHER_MESSAGE.id);
        await results;

        // At most: a timer of another spec may expire meanwhile, while a timer left by the waiter keeps
        // the run alive.
        expect(activeTimerCount()).to.be.at.most(timerCount);
    });

    it("skips a poll while the previous one is still running", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });
        const lookup = source.holdLookups();

        const result = waiter.wait(MESSAGE.id);
        await waitFor(() => source.lookups.length === 1);
        await sleep(QUIET_MS);

        expect(source.lookups).to.have.length(1);

        source.finish(MESSAGE);
        lookup.resolve();

        expect(await result).to.deep.equal(MESSAGE);
    });

    it("rejects a wait with OutboxResultTimeout after timeoutMs", async function () {
        const source = new FakeSource();
        const waiter = build(source, { timeoutMs: SOON_MS });

        const error = await rejection(waiter.wait(MESSAGE.id));

        expect(error).to.be.instanceOf(OutboxResultTimeout);
        expect((error as OutboxResultTimeout).message).to.equal(`Outbox message ${MESSAGE.id} did not finish within ${SOON_MS} ms.`);
        expect((error as OutboxResultTimeout).payload).to.deep.equal({ messageId: MESSAGE.id, timeoutMs: SOON_MS });
    });

    it("forgets a message whose wait has timed out", async function () {
        const source = new FakeSource();
        const waiter = build(source, { timeoutMs: SOON_MS, pollIntervalMs: SOON_MS });

        await rejection(waiter.wait(MESSAGE.id));
        const lookupCount = source.lookups.length;
        source.notify(MESSAGE.id);
        await sleep(QUIET_MS);

        expect(source.lookups).to.have.length(lookupCount);
    });

    it("waits anew for a message whose wait has timed out", async function () {
        const source = new FakeSource();
        const waiter = build(source, { timeoutMs: SOON_MS });

        await rejection(waiter.wait(MESSAGE.id));
        source.finish(MESSAGE);
        const result = waiter.wait(MESSAGE.id);
        source.notify(MESSAGE.id);

        expect(await result).to.deep.equal(MESSAGE);
    });

    it("leaves alone a message a lookup finds after its wait has timed out", async function () {
        const source = new FakeSource();
        // The poll starts its lookup before the timeout.
        const waiter = build(source, { timeoutMs: QUIET_MS, pollIntervalMs: SOON_MS });
        const lookup = source.holdLookups();
        source.finish(MESSAGE);

        const result = waiter.wait(MESSAGE.id);
        await waitFor(() => source.lookups.length === 1);
        const error = await rejection(result);
        lookup.resolve();
        await sleep(QUIET_MS);

        expect(error).to.be.instanceOf(OutboxResultTimeout);
        expect(source.lookups).to.have.length(1);
    });

    it("gives a second wait for the same message the same promise", function () {
        const waiter = build(new FakeSource(), { timeoutMs: SOON_MS });

        const first = waiter.wait(MESSAGE.id);
        const second = waiter.wait(MESSAGE.id);

        expect(second).to.equal(first);

        return rejection(first);
    });

    it("does not let the timeout of a settled wait end a later wait for the same message", async function () {
        const source = new FakeSource();
        const waiter = build(source, { timeoutMs: SHORT_TIMEOUT_MS });
        source.finish(MESSAGE);

        const first = waiter.wait(MESSAGE.id);
        source.notify(MESSAGE.id);
        await first;
        await sleep(SHORT_TIMEOUT_SHARE_MS);
        const second = waiter.wait(MESSAGE.id);
        // Past the timeout of the first wait, within the timeout of the second.
        await sleep(SHORT_TIMEOUT_SHARE_MS);
        source.notify(MESSAGE.id);

        expect(await second).to.deep.equal(MESSAGE);
    });

    it("keeps the timeout of a message running after another message is settled", async function () {
        const source = new FakeSource();
        const waiter = build(source, { timeoutMs: QUIET_MS });

        const pending = waiter.wait(OTHER_MESSAGE.id);
        const settled = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await settled;

        expect(await rejection(pending)).to.be.instanceOf(OutboxResultTimeout);
    });

    it("listens once for all the waits", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const results = Promise.all([waiter.wait(MESSAGE.id), waiter.wait(OTHER_MESSAGE.id)]);
        source.finish(MESSAGE);
        source.finish(OTHER_MESSAGE);
        source.notify(MESSAGE.id);
        source.notify(OTHER_MESSAGE.id);
        await results;

        expect(source.listenCount).to.equal(1);
    });

    it("logs a failed start of the listening and leaves the waits to the poll", async function () {
        const source = new FakeSource();
        const logger = new RecordingLogger();
        const waiter = build(source, { pollIntervalMs: SOON_MS }, logger);
        const listenError = new Error("connection refused");
        source.listenError = listenError;

        const result = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);

        expect(await result).to.deep.equal(MESSAGE);
        expect(logger.warnings).to.deep.equal([
            {
                message: "Listening for finished outbox messages failed, the waits rely on the poll.",
                payload: { cause: listenError },
            },
        ]);
    });

    // postgres.js keeps the listener of a failed LISTEN and subscribes it again itself: a second
    // call would leave two listeners, and every notification would be read twice.
    it("does not start the listening again after a failed start", async function () {
        const source = new FakeSource();
        const waiter = build(source, { pollIntervalMs: SOON_MS });
        source.listenError = new Error("connection refused");

        const first = waiter.wait(MESSAGE.id);
        source.finish(MESSAGE);
        await first;
        const second = waiter.wait(OTHER_MESSAGE.id);
        source.finish(OTHER_MESSAGE);
        await second;

        expect(source.listenCount).to.equal(1);
    });

    it("polls again once a running poll ends when the listening starts meanwhile", async function () {
        const source = new FakeSource();
        const waiter = build(source);
        const lookup = source.holdLookups();

        const result = waiter.wait(MESSAGE.id);
        source.listenStarted();
        await waitFor(() => source.lookups.length === 1);
        // Finished after the running lookup has read, and notified while nobody listened.
        source.finish(MESSAGE);
        source.listenStarted();
        lookup.resolve();

        expect(await result).to.deep.equal(MESSAGE);
        expect(source.lookups).to.have.length(2);
    });

    it("polls once when the listening starts", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const result = waiter.wait(MESSAGE.id);
        source.listenStarted();
        await sleep(QUIET_MS);

        expect(source.lookups).to.have.length(1);

        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await result;
    });

    it("polls only once more after a running poll when the listening starts meanwhile", async function () {
        const source = new FakeSource();
        const waiter = build(source);
        const lookup = source.holdLookups();

        const result = waiter.wait(MESSAGE.id);
        source.listenStarted();
        await waitFor(() => source.lookups.length === 1);
        source.listenStarted();
        lookup.resolve();
        await sleep(QUIET_MS);

        expect(source.lookups).to.have.length(2);

        source.finish(MESSAGE);
        source.notify(MESSAGE.id);
        await result;
    });

    it("rejects every pending wait with OutboxResultWaiterStopped on stop()", async function () {
        const waiter = build(new FakeSource());

        const first = waiter.wait(MESSAGE.id);
        const second = waiter.wait(OTHER_MESSAGE.id);
        waiter.stop();
        const errors = [await rejection(first), await rejection(second)];

        expect(errors.map((error) => (error as OutboxResultWaiterStopped).payload)).to.deep.equal([
            { messageId: MESSAGE.id },
            { messageId: OTHER_MESSAGE.id },
        ]);
        expect(errors[0]).to.be.instanceOf(OutboxResultWaiterStopped);
        expect((errors[0] as OutboxResultWaiterStopped).message).to.equal(`The wait for outbox message ${MESSAGE.id} was stopped.`);
    });

    it("leaves no timer behind after stop()", async function () {
        const waiter = build(new FakeSource());
        // mocha starts the timer of the test once the synchronous part of the test has returned.
        await Promise.resolve();
        const timerCount = activeTimerCount();

        const results = [waiter.wait(MESSAGE.id), waiter.wait(OTHER_MESSAGE.id)];
        waiter.stop();
        await Promise.all(results.map(rejection));

        // At most: a timer of another spec may expire meanwhile.
        expect(activeTimerCount()).to.be.at.most(timerCount);
    });

    it("waits anew for a message after stop()", async function () {
        const source = new FakeSource();
        const waiter = build(source);

        const stopped = waiter.wait(MESSAGE.id);
        waiter.stop();
        await rejection(stopped);
        source.finish(MESSAGE);
        const result = waiter.wait(MESSAGE.id);
        source.notify(MESSAGE.id);

        expect(await result).to.deep.equal(MESSAGE);
    });

    it("logs a failed lookup and settles the wait by the next poll", async function () {
        const source = new FakeSource();
        const logger = new RecordingLogger();
        const waiter = build(source, { pollIntervalMs: SOON_MS }, logger);
        const lookupError = new Error("connection lost");
        source.lookupError = lookupError;

        const result = waiter.wait(MESSAGE.id);
        await waitFor(() => source.lookups.length >= 1);
        source.lookupError = undefined;
        source.finish(MESSAGE);

        expect(await result).to.deep.equal(MESSAGE);
        expect(logger.warnings[0]).to.deep.equal({
            message: "Reading finished outbox messages failed, the next poll tries again.",
            payload: { messageIds: [MESSAGE.id], cause: lookupError },
        });
    });
});

// The store as the waiter sees it: the finished messages are set by the test, and so are the
// notifications and the start of the listening.
class FakeSource implements FinishedMessageSource {
    public readonly lookups: number[][] = [];
    public listenCount = 0;
    public listenError: Error | undefined;
    public lookupError: Error | undefined;

    private readonly finished = new Map<number, FinishedOutboxMessage>();
    private onFinished: ((messageId: number) => void) | undefined;
    private onListen: (() => void) | undefined;
    private heldLookup: Promise<void> | undefined;

    public async findFinished(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        this.lookups.push(messageIds);
        // Read when the lookup starts, as a query reads its snapshot: a message finished while the
        // lookup is held is not in its answer.
        const finishedMessages = messageIds.flatMap((messageId) => this.finished.get(messageId) ?? []);
        await this.heldLookup;

        if (this.lookupError !== undefined) {
            throw this.lookupError;
        }

        return finishedMessages;
    }

    public async listenForFinished(onFinished: (messageId: number) => void, onListen: () => void): Promise<void> {
        this.listenCount += 1;

        if (this.listenError !== undefined) {
            throw this.listenError;
        }

        this.onFinished = onFinished;
        this.onListen = onListen;
    }

    public finish(message: FinishedOutboxMessage): void {
        this.finished.set(message.id, message);
    }

    public notify(messageId: number): void {
        this.onFinished?.(messageId);
    }

    public listenStarted(): void {
        this.onListen?.();
    }

    // Every lookup from now on waits until the returned resolve() is called.
    public holdLookups(): { resolve: () => void } {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.heldLookup = promise;

        return { resolve: resolve };
    }
}

class RecordingLogger implements Logger {
    public readonly warnings: Array<{ message: string; payload: UnknownObject | undefined }> = [];

    public critical(): void {}

    public error(): void {}

    public warning(message: string, payload?: UnknownObject): void {
        this.warnings.push({ message: message, payload: payload });
    }

    public info(): void {}

    public debug(): void {}
}

function build(
    source: FakeSource,
    settings: Partial<OutboxResultWaiterSettings> = {},
    logger: Logger = new RecordingLogger(),
): OutboxResultWaiter {
    return new OutboxResultWaiter(source, logger, { timeoutMs: NEVER_MS, pollIntervalMs: NEVER_MS, ...settings });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }

    return expect.fail("the wait was expected to reject");
}

// setTimeout and setInterval both count as a Timeout resource of Node.
function activeTimerCount(): number {
    return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

// The deadline is shorter than the timeout of mocha, so a condition never met fails here.
async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + NEVER_MS;

    while (!condition()) {
        if (Date.now() > deadline) {
            expect.fail("the condition was not met in time");
        }

        await sleep(1);
    }
}
