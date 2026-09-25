import { expect } from "chai";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import type { Logger } from "app/platform/logger/logger";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";

// The limits are taken small so that the run does not stall on cooldowns: the common slot is
// released in 1 ms, the slot of a key in 10 ms.
const commonLimit: Limit = { number: 1000, interval: 1000 };
const commonCooldown = commonLimit.interval / commonLimit.number;
const keyLimit: Limit = { number: 100, interval: 1000 };
const keyCooldown = keyLimit.interval / keyLimit.number;

// A limit that does not cool down during a test: no delay in the run reaches its end. Given to a key,
// it holds only that key: the common limit is released within the same pause.
const frozenLimit: Limit = { number: 1, interval: 60 * 1000 };

// Nothing stops the log intervals of TaskQueue, and they live until the end of the run. So the default
// period is longer than any run, and only the tests of the log itself take a short one.
const silentLogInterval = 60 * 1000;
const logInterval = 10;

// The waiting deadline is shorter than the test timeout: otherwise a condition that can never be met
// would keep the polling loop spinning after the test has failed, and mocha without --exit would not
// finish.
const waitLimit = 1000;

describe("TaskQueue", function () {
    this.timeout(2000);

    it("gives out the higher priority first, whatever key it belongs to", function () {
        const queue = build();
        queue.push(task(111, "medium"), Priority.MEDIUM);
        queue.push(task(222, "high"), Priority.HIGH);

        expect(queue.pull()?.key).to.equal(222);
    });

    it("does not let one key hold the head of a priority", async function () {
        const queue = build();
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);
        queue.push(task(222, "b1"), Priority.MEDIUM);

        expect(queue.pull()?.key).to.equal(111);
        await delay(keyCooldown + 5);

        expect(queue.pull()?.key).to.equal(222);
    });

    it("puts a key that comes back with a new task behind the keys already waiting", async function () {
        // An emptied bucket must remove the key from the priority index. Otherwise add() in push() leaves
        // it in its old place, ahead of 222. The pause lets both keys cool down: while the limit of 111 is
        // busy, 222 would come out first even if the rule were broken.
        const queue = build();
        queue.push(task(111, "a1"), Priority.MEDIUM);

        expect(queue.pull()?.key).to.equal(111);
        queue.push(task(222, "b1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);
        await delay(keyCooldown + 5);

        expect(queue.pull()?.key).to.equal(222);
    });

    it("skips a key whose limit has not cooled down", async function () {
        const queue = build({ keyLimit: () => frozenLimit });
        queue.push(task(111, "a-high"), Priority.HIGH);
        queue.push(task(111, "a-medium"), Priority.MEDIUM);
        queue.push(task(222, "b-medium"), Priority.MEDIUM);

        expect(queue.pull()?.key).to.equal(111);
        await delay(commonCooldown + 5);

        expect(queue.pull()?.key).to.equal(222);
    });

    it("gives out the tasks of one key in the order they were pushed", async function () {
        const queue = build();
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(222, "b1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);
        queue.push(task(222, "b2"), Priority.MEDIUM);
        queue.push(task(111, "a3"), Priority.MEDIUM);

        const names = await namesByKey(await drain(queue));

        expect(names.get(111)).to.deep.equal(["a1", "a2", "a3"]);
        expect(names.get(222)).to.deep.equal(["b1", "b2"]);
    });

    it("keeps the key limit while the partition cools down", async function () {
        const queue = build({ keyLimit: () => frozenLimit });
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);

        expect(queue.pull()).to.be.an("object");
        // Without the pause the second pull() would return null because of the busy common limit, not the
        // limit of the key.
        await delay(commonCooldown + 5);

        expect(queue.pull()).to.be.null;
        expect(queue.getTaskCount()).to.equal(1);
    });

    it("gives out nothing to any key while the common limit has not cooled down", function () {
        const queue = build({ commonLimit: frozenLimit });
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(222, "b1"), Priority.MEDIUM);

        expect(queue.pull()?.key).to.equal(111);
        expect(queue.pull()).to.be.null;
        expect(queue.getTaskCount()).to.equal(1);
    });

    it("forgets a partition once it is empty and cooled down", async function () {
        const queue = build();
        queue.push(task(111, "only"), Priority.MEDIUM);
        queue.pull();

        expect(queue.getPartitionCount()).to.equal(1);
        await delay(keyCooldown + 5);
        queue.pull();

        expect(queue.getPartitionCount()).to.equal(0);
        expect(queue.isEmpty()).to.be.true;
    });

    it("keeps a partition that got a new task before the cleanup", async function () {
        const queue = build();
        queue.push(task(111, "first"), Priority.MEDIUM);
        queue.pull();
        queue.push(task(111, "second"), Priority.MEDIUM);
        await delay(keyCooldown + 5);
        queue.pull();

        expect(queue.getPartitionCount()).to.equal(1);
    });

    it("forgets at most a hundred idle partitions per pull", async function () {
        // A key that does not cool down holds the head of idleKeys. While it is there, the cleanup stalls
        // on it, and cooled-down partitions pile up behind it however long the queue gives out tasks. A
        // new task takes it out of idleKeys, and the next pull() stalls on the ceiling instead.
        const blocker = "blocker";
        const queue = build({ keyLimit: (key) => (key === blocker ? frozenLimit : keyLimit) });
        queue.push(task(blocker, "first"), Priority.MEDIUM);

        for (let key = 1; key <= 101; key++) {
            queue.push(task(key, "only"), Priority.MEDIUM);
        }

        await drain(queue);
        await delay(keyCooldown + 5);
        queue.push(task(blocker, "second"), Priority.MEDIUM);

        queue.pull();
        expect(queue.getPartitionCount()).to.equal(2);

        queue.pull();
        expect(queue.getPartitionCount()).to.equal(1);
    });

    it("gives out nothing while the ban lasts", function () {
        const queue = build();
        queue.push(task(111, "only"), Priority.MEDIUM);
        queue.ban(1000);

        expect(queue.pull()).to.be.null;
        expect(queue.getTaskCount()).to.equal(1);
    });

    it("keeps the current ban when asked for one that is already over", function () {
        const queue = build();
        queue.push(task(111, "only"), Priority.MEDIUM);
        queue.ban(1000);
        queue.ban(-1);

        expect(queue.pull()).to.be.null;
    });

    it("logs the task and partition count every log interval", async function () {
        const logger = new RecordingLogger();
        const queue = build({ logger: logger, logInterval: logInterval });
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);
        queue.push(task(222, "b1"), Priority.MEDIUM);

        await waitFor(() => logger.infos.length > 0);

        expect(logger.infos[0]).to.equal("Number of tasks in the queue: 3. Number of partitions: 2");
    });

    it("logs how long the ban lasts", async function () {
        const logger = new RecordingLogger();
        const queue = build({ logger: logger, logInterval: logInterval });
        queue.ban(1500);

        await waitFor(() => logger.infos.some(isBanLog));

        expect(logger.infos.filter(isBanLog)[0]).to.equal("Ban expires in 1 second.");
    });

    it("does not log a ban that is absent or already over", async function () {
        const logger = new RecordingLogger();
        const queue = build({ logger: logger, logInterval: logInterval });

        await waitFor(() => logger.infos.length >= 1);
        expect(logger.infos.filter(isBanLog)).to.be.empty;

        queue.ban(1);
        // A log tick queued together with the wait may fire in the same millisecond as ban(1) and rightly
        // catch the pause. So the records are counted from a point where a one-millisecond pause has
        // certainly expired. The task count is logged before the pause, so a second record after that
        // point means the pause check behind it has already run.
        await delay(5);
        const expired = logger.infos.length;
        await waitFor(() => logger.infos.length >= expired + 2);

        expect(logger.infos.slice(expired).filter(isBanLog)).to.be.empty;
    });
});

class RecordingLogger implements Logger {
    public readonly infos: string[] = [];

    public critical(): void {}

    public error(): void {}

    public warning(): void {}

    public info(message: string): void {
        this.infos.push(message);
    }

    public debug(): void {}
}

type BuildOptions = {
    keyLimit?: (key: PartitionKey) => Limit;
    commonLimit?: Limit;
    logger?: Logger;
    logInterval?: number;
};

function build(options: BuildOptions = {}): TaskQueue {
    const limitResolver: LimitResolver = {
        resolve: (task) => (options.keyLimit ? options.keyLimit(task.key) : keyLimit),
    };

    return new TaskQueue(
        options.logger ?? new RecordingLogger(),
        limitResolver,
        options.commonLimit ?? commonLimit,
        options.logInterval ?? silentLogInterval,
    );
}

function task(key: PartitionKey, name: string): Task {
    return {
        key: key,
        priorityOnError: Priority.HIGH,
        callback: () => Promise.resolve(name),
    };
}

// Takes everything out of the queue, waiting for the limits to cool down, and returns the tasks in the
// order they were given out.
async function drain(queue: TaskQueue): Promise<Task[]> {
    const tasks: Task[] = [];
    const deadline = Date.now() + waitLimit;

    while (!queue.isEmpty()) {
        if (Date.now() > deadline) {
            expect.fail(`the queue is not drained within ${waitLimit} ms`);
        }

        const pulled = queue.pull();

        if (pulled) {
            tasks.push(pulled);
        } else {
            await delay(1);
        }
    }

    return tasks;
}

async function namesByKey(tasks: Task[]): Promise<Map<PartitionKey, unknown[]>> {
    const names = new Map<PartitionKey, unknown[]>();

    for (const pulled of tasks) {
        names.set(pulled.key, [...(names.get(pulled.key) ?? []), await pulled.callback()]);
    }

    return names;
}

function isBanLog(message: string): boolean {
    return message.startsWith("Ban expires");
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
