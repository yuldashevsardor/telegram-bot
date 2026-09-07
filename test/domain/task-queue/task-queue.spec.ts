import { expect } from "chai";
import { container } from "app/infrastructure/container/container";
import { ConfigContainer } from "app/infrastructure/config/config-container";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { LimitResolver } from "app/domain/task-queue/limit-resolver";
import { Logger } from "app/domain/logger/logger";
import { PartitionKey, Priority, Task } from "app/domain/task-queue/task";
import { TaskQueue } from "app/domain/task-queue/task-queue";

// Лимиты берутся маленькими, чтобы прогон не упирался в остывание: общий слот освобождается за
// 1 мс, слот ключа — за 10 мс.
const commonLimit: Limit = { number: 1000, interval: 1000 };
const keyLimit: Limit = { number: 100, interval: 1000 };
const keyCooldown = keyLimit.interval / keyLimit.number;

// ConfigContainer подменяется целиком: @ConfigValue читает его из DI-контейнера, и подставленный
// объект избавляет тест от .env и от реальных лимитов бота.
if (!container.isBound(Infrastructure.ConfigContainer)) {
    container.bind<ConfigContainer>(Infrastructure.ConfigContainer).toConstantValue({
        limits: { common: commonLimit, private: keyLimit, group: keyLimit },
    } as unknown as ConfigContainer);
}

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

    it("keeps the key limit while the partition cools down", function () {
        const queue = build();
        queue.push(task(111, "a1"), Priority.MEDIUM);
        queue.push(task(111, "a2"), Priority.MEDIUM);

        expect(queue.pull()).to.be.an("object");
        expect(queue.pull()).to.be.null;
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

    it("gives out nothing while the ban lasts", function () {
        const queue = build();
        queue.push(task(111, "only"), Priority.MEDIUM);
        queue.ban(1000);

        expect(queue.pull()).to.be.null;
        expect(queue.getTaskCount()).to.equal(1);
    });
});

function build(): TaskQueue {
    const logger: Logger = {
        critical: () => undefined,
        error: () => undefined,
        warning: () => undefined,
        info: () => undefined,
        debug: () => undefined,
    };

    const limitResolver: LimitResolver = {
        resolve: () => keyLimit,
    };

    return new TaskQueue(logger, limitResolver);
}

function task(key: PartitionKey, name: string): Task {
    return {
        key: key,
        priorityOnError: Priority.HIGH,
        callback: () => Promise.resolve(name),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
