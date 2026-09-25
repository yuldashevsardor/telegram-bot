import { expect } from "chai";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import { Runner } from "app/telegram/outbound-queue/runner/runner";
import { RunnerAlreadyRun } from "app/telegram/outbound-queue/runner/runner.errors";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner/runner.types";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { DEFAULT_RETRY_AFTER_SECONDS } from "app/telegram/outbound-queue/telegram-error";

// The common slot and the slot of a key are released in 1 ms: the pace of giving out is not checked
// here and must not stretch the run.
const limit: Limit = { number: 1000, interval: 1000 };
const settings: RunnerSettings = {
    sleepInterval: { min: 1, max: 5 },
    maxRetries: 2,
};

const DROPPED = "Task is dropped: retry limit is reached.";

// The waiting deadline is shorter than the test timeout: otherwise a condition that can never be met
// would keep the polling loop spinning after the test has failed, and mocha without --exit would not
// finish.
const waitLimit = 1000;

type LogRecord = {
    message: string;
    payload: UnknownObject | undefined;
};

class RecordingLogger implements Logger {
    public readonly errors: LogRecord[] = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(): void {}

    public info(): void {}

    public debug(): void {}

    public countDropped(): number {
        return this.errors.filter((record) => record.message === DROPPED).length;
    }
}

// Records the pause of the queue without setting it: otherwise the loop would really wait it out. This
// spec checks the duration Runner assigns; the TaskQueue spec pins the pause itself.
class RecordingQueue extends TaskQueue {
    public readonly bans: number[] = [];
    public readonly pushes: Array<{ task: Task; priority: Priority }> = [];

    public constructor() {
        const limitResolver: LimitResolver = {
            resolve: () => limit,
        };

        super(new RecordingLogger(), limitResolver, limit, 60 * 1000);
    }

    public override push(task: Task, priority: Priority): void {
        this.pushes.push({ task: task, priority: priority });
        super.push(task, priority);
    }

    public override ban(duration: number): void {
        this.bans.push(duration);
    }
}

describe("Runner", function () {
    this.timeout(2000);

    // An unfinished loop keeps the event loop alive and mocha would not exit after the run, so every
    // started Runner is stopped even when the test has failed.
    const started: Runner[] = [];

    function start(queue: TaskQueue, logger: Logger = new RecordingLogger(), runnerSettings: RunnerSettings = settings): Runner {
        const runner = new Runner(queue, logger, runnerSettings);
        started.push(runner);
        runner.run();

        return runner;
    }

    afterEach(function () {
        for (const runner of started.splice(0)) {
            runner.stop();
        }
    });

    it("runs the callback of a pushed task", async function () {
        const queue = new RecordingQueue();
        let calls = 0;
        queue.push(
            task(111, () => {
                calls++;
                return Promise.resolve();
            }),
            Priority.MEDIUM,
        );

        start(queue);
        await waitForCount(() => calls, 1, "calls");

        expect(queue.isEmpty()).to.be.true;
    });

    it("sleeps on an empty queue and picks up a task pushed meanwhile once it wakes", async function () {
        // Without the sleep the task would come out milliseconds after push(). The threshold is half the
        // sleep rather than the whole of it: setTimeout counts its deadline from the time cached by the
        // event loop and may fire slightly earlier than Date.now() shows.
        const sleep = 300;
        const queue = new RecordingQueue();
        const startedAt = Date.now();
        let calledAt = 0;

        start(queue, new RecordingLogger(), { ...settings, sleepInterval: { min: sleep, max: sleep } });
        await delay(10);
        queue.push(
            task(111, () => {
                calledAt = Date.now();
                return Promise.resolve();
            }),
            Priority.MEDIUM,
        );

        await waitFor(() => calledAt > 0);

        expect(calledAt - startedAt).to.be.at.least(sleep / 2);
    });

    it("does not wait for a call to finish before taking the next task", async function () {
        const queue = new RecordingQueue();
        let secondCalls = 0;
        queue.push(
            task(111, () => new Promise(() => undefined)),
            Priority.MEDIUM,
        );
        queue.push(
            task(222, () => {
                secondCalls++;
                return Promise.resolve();
            }),
            Priority.MEDIUM,
        );

        start(queue);

        await waitForCount(() => secondCalls, 1, "calls of the second task");
    });

    it("refuses to run twice", function () {
        const runner = start(new RecordingQueue());

        expect(() => runner.run()).to.throw(RunnerAlreadyRun, "Runner is already run.");
    });

    it("takes no tasks once stopped", async function () {
        const queue = new RecordingQueue();
        let calls = 0;

        const runner = start(queue);
        runner.stop();
        queue.push(
            task(111, () => {
                calls++;
                return Promise.resolve();
            }),
            Priority.MEDIUM,
        );
        await delay(settings.sleepInterval.max * 4);

        expect(runner.isRun).to.be.false;
        expect(calls).to.equal(0);
        expect(queue.getTaskCount()).to.equal(1);
    });

    it("logs a failed call and returns the task with its priority on error", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        const failure = new Error("network is down");
        let calls = 0;
        queue.push(
            task(
                111,
                () => {
                    calls++;
                    return calls === 1 ? Promise.reject(failure) : Promise.resolve();
                },
                Priority.LOW,
            ),
            Priority.HIGH,
        );

        start(queue, logger);
        await waitForCount(() => calls, 2, "calls");

        expect(queue.pushes.map((push) => push.priority)).to.deep.equal([Priority.HIGH, Priority.LOW]);
        expect(queue.pushes[1]?.task.retryCount).to.equal(1);
        expect(logger.errors).to.deep.equal([{ message: "Telegram API call is failed.", payload: { cause: failure } }]);
    });

    it("drops a task once its retries are spent", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        let calls = 0;
        queue.push(
            task(111, () => {
                calls++;
                return Promise.reject(new Error("network is down"));
            }),
            Priority.MEDIUM,
        );

        start(queue, logger);
        await waitForCount(() => logger.countDropped(), 1, "dropped tasks");

        expect(calls).to.equal(settings.maxRetries + 1);
        expect(queue.pushes.map((push) => push.task.retryCount)).to.deep.equal([undefined, 1, 2]);
        expect(logger.errors.find((record) => record.message === DROPPED)?.payload).to.deep.equal({
            key: 111,
            maxRetries: settings.maxRetries,
        });
        expect(queue.isEmpty()).to.be.true;
    });

    it("pauses the queue for retry_after seconds on 429", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        queue.push(failingTask(111, tooManyRequests({ retry_after: 7 })), Priority.MEDIUM);

        start(queue, logger, { ...settings, maxRetries: 0 });
        await waitForCount(() => logger.countDropped(), 1, "dropped tasks");

        expect(queue.bans).to.deep.equal([7 * 1000]);
    });

    it("pauses the queue for the default time when retry_after is missing or unreadable", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        const failures = [
            tooManyRequests(),
            tooManyRequests({}),
            tooManyRequests({ retry_after: "soon" }),
            tooManyRequests({ retry_after: 0 }),
        ];
        failures.forEach((failure, index) => queue.push(failingTask(index, failure), Priority.MEDIUM));

        start(queue, logger, { ...settings, maxRetries: 0 });
        await waitForCount(() => logger.countDropped(), failures.length, "dropped tasks");

        expect(queue.bans).to.deep.equal(failures.map(() => DEFAULT_RETRY_AFTER_SECONDS * 1000));
    });

    it("does not pause the queue on other failures", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        const failures: unknown[] = [new Error("network is down"), "network is down", null, { error_code: 400 }];
        failures.forEach((failure, index) => queue.push(failingTask(index, failure), Priority.MEDIUM));

        start(queue, logger, { ...settings, maxRetries: 0 });
        await waitForCount(() => logger.countDropped(), failures.length, "dropped tasks");

        expect(queue.bans).to.be.empty;
    });
});

function task(key: PartitionKey, callback: () => Promise<unknown>, priorityOnError: Priority = Priority.MEDIUM): Task {
    return {
        key: key,
        priorityOnError: priorityOnError,
        callback: callback,
    };
}

function failingTask(key: PartitionKey, failure: unknown): Task {
    return task(key, () => Promise.reject(failure));
}

// The shape of a Bot API rejection as Runner sees it: it looks only at the fields, not at the class of
// the error.
function tooManyRequests(parameters?: UnknownObject): UnknownObject {
    return parameters === undefined ? { error_code: 429 } : { error_code: 429, parameters: parameters };
}

// Waits for a number of events, not for a predicate over it. With a monotonic counter, strict equality
// is false on an overshoot too, so a predicate would sit out the deadline and report the overshoot as a
// shortfall. The shape is explained at waitForSignals in
// test/bootstrap/config/storage/config-file-storage.spec.ts.
async function waitForCount(counter: () => number, expected: number, subject: string): Promise<void> {
    const deadline = Date.now() + waitLimit;
    let actual = counter();

    while (actual !== expected) {
        if (actual > expected || Date.now() > deadline) {
            expect(actual).to.equal(expected, `unexpected number of ${subject}`);
        }

        await delay(1);
        actual = counter();
    }
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + waitLimit;

    while (!condition()) {
        if (Date.now() > deadline) {
            expect.fail(`the condition is not met within ${waitLimit} ms`);
        }

        await delay(1);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
