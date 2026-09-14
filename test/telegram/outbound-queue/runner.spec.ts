import { expect } from "chai";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import type { Limit } from "app/telegram/outbound-queue/rate-limit.types";
import { Runner } from "app/telegram/outbound-queue/runner";
import { RunnerAlreadyRun } from "app/telegram/outbound-queue/runner.errors";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner.types";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { DEFAULT_RETRY_AFTER_SECONDS } from "app/telegram/outbound-queue/telegram-error";

// Общий слот и слот ключа освобождаются за 1 мс: темп выдачи здесь не проверяется и не должен
// растягивать прогон.
const limit: Limit = { number: 1000, interval: 1000 };
const settings: RunnerSettings = {
    sleepInterval: { min: 1, max: 5 },
    maxRetries: 2,
};

const DROPPED = "Task is dropped: retry limit is reached.";

// Срок ожидания короче таймаута теста: невыполнимое условие иначе крутило бы цикл опроса и после
// упавшего теста, и mocha без --exit не завершился бы.
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

// Паузу очереди записывает, но не ставит: иначе цикл ждал бы её по-настоящему. Проверяется здесь
// длительность, которую назначает Runner, а саму паузу закрепляет спека TaskQueue.
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

    // Незавершённый цикл держит событийный цикл живым, и mocha не вышел бы после прогона, поэтому
    // каждый запущенный Runner гасится и при упавшем тесте.
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
        await waitFor(() => calls === 1);

        expect(queue.isEmpty()).to.be.true;
    });

    it("picks up a task pushed while it sleeps on an empty queue", async function () {
        const queue = new RecordingQueue();
        let calls = 0;

        start(queue);
        await delay(settings.sleepInterval.max * 4);
        queue.push(
            task(111, () => {
                calls++;
                return Promise.resolve();
            }),
            Priority.MEDIUM,
        );

        await waitFor(() => calls === 1);
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

        await waitFor(() => secondCalls === 1);
    });

    it("refuses to run twice", function () {
        const runner = start(new RecordingQueue());

        expect(() => runner.run()).to.throw(RunnerAlreadyRun);
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
        await waitFor(() => calls === 2);

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
        await waitFor(() => logger.countDropped() === 1);

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
        await waitFor(() => logger.countDropped() === 1);

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
        await waitFor(() => logger.countDropped() === failures.length);

        expect(queue.bans).to.deep.equal(failures.map(() => DEFAULT_RETRY_AFTER_SECONDS * 1000));
    });

    it("does not pause the queue on other failures", async function () {
        const queue = new RecordingQueue();
        const logger = new RecordingLogger();
        const failures: unknown[] = [new Error("network is down"), "network is down", null, { error_code: 400 }];
        failures.forEach((failure, index) => queue.push(failingTask(index, failure), Priority.MEDIUM));

        start(queue, logger, { ...settings, maxRetries: 0 });
        await waitFor(() => logger.countDropped() === failures.length);

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

// Форма отказа Bot API, как её видит Runner: он смотрит только на поля, а не на класс ошибки.
function tooManyRequests(parameters?: UnknownObject): UnknownObject {
    return parameters === undefined ? { error_code: 429 } : { error_code: 429, parameters: parameters };
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
