import { expect } from "chai";
import type { Limit } from "app/telegram/outbound-queue/rate-limit.types";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import type { Logger } from "app/platform/logger/logger";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";

// Лимиты берутся маленькими, чтобы прогон не упирался в остывание: общий слот освобождается за
// 1 мс, слот ключа — за 10 мс.
const commonLimit: Limit = { number: 1000, interval: 1000 };
const commonCooldown = commonLimit.interval / commonLimit.number;
const keyLimit: Limit = { number: 100, interval: 1000 };
const keyCooldown = keyLimit.interval / keyLimit.number;

// Ключ, который за время теста не остывает вовсе: общий лимит успевает освободиться, а лимит ключа
// нет, и ни одна задержка в прогоне не дотягивает до его конца.
const frozenKeyLimit: Limit = { number: 1, interval: 60 * 1000 };

// Интервалы журнала TaskQueue ничем не гасятся и живут до конца прогона, поэтому по умолчанию
// период длиннее любого прогона, а короткий берут только тесты самого журнала.
const silentLogInterval = 60 * 1000;
const logInterval = 10;

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

    it("skips a key whose limit has not cooled down", async function () {
        const queue = build({ keyLimit: frozenKeyLimit });
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
        const queue = build({ keyLimit: frozenKeyLimit });
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);

        expect(queue.pull()).to.be.an("object");
        // Без паузы второй pull() вернул бы null из-за занятого общего лимита, а не лимита ключа.
        await delay(commonCooldown + 5);

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
        // Остывание дольше, чем очередь отдаёт 101 задачу под общим лимитом: иначе ранние партиции
        // снимались бы по ходу выдачи, и до одного вызова с сотней не дошло бы.
        const idleKeyLimit: Limit = { number: 1, interval: 500 };
        const queue = build({ keyLimit: idleKeyLimit });

        for (let key = 1; key <= 101; key++) {
            queue.push(task(key, "only"), Priority.MEDIUM);
        }

        await drain(queue);
        expect(queue.getPartitionCount()).to.equal(101);
        await delay(idleKeyLimit.interval + 5);

        queue.pull();
        expect(queue.getPartitionCount()).to.equal(1);

        queue.pull();
        expect(queue.getPartitionCount()).to.equal(0);
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
        queue.ban(1);
        // Журнал числа задач пишется раньше журнала паузы, поэтому третья запись гарантирует, что
        // проверка паузы после ban() уже отработала.
        await waitFor(() => logger.infos.length >= 3);

        expect(logger.infos.filter(isBanLog)).to.be.empty;
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
    keyLimit?: Limit;
    logger?: Logger;
    logInterval?: number;
};

function build(options: BuildOptions = {}): TaskQueue {
    const limitResolver: LimitResolver = {
        resolve: () => options.keyLimit ?? keyLimit,
    };

    return new TaskQueue(options.logger ?? new RecordingLogger(), limitResolver, commonLimit, options.logInterval ?? silentLogInterval);
}

function task(key: PartitionKey, name: string): Task {
    return {
        key: key,
        priorityOnError: Priority.HIGH,
        callback: () => Promise.resolve(name),
    };
}

// Забирает из очереди всё, дожидаясь остывания лимитов, и возвращает задачи в порядке выдачи.
async function drain(queue: TaskQueue): Promise<Task[]> {
    const tasks: Task[] = [];

    while (!queue.isEmpty()) {
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
    while (!condition()) {
        await delay(1);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
