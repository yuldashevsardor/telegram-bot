import { inject, injectable } from "inversify";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Logger } from "app/domain/logger/logger";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { Partition } from "app/domain/dispatcher/partition";
import { Rate, RateLimit } from "app/domain/dispatcher/rate-limit";
import { PRIORITY, Task, TaskKey } from "app/domain/dispatcher/task";

type KeysByPriority = {
    [key in PRIORITY]: Set<TaskKey>;
};

@injectable()
export class Dispatcher {
    @ConfigValue<Rate>("rates.common")
    private readonly commonRate!: Rate;

    private readonly partitions: Map<TaskKey, Partition>;

    // Индекс «у кого есть задачи этого приоритета»: без него поиск очередной задачи означал бы
    // обход всех партиций. Set хранит ключи в порядке вставки, он же задаёт очерёдность ключей
    // внутри приоритета.
    private readonly keysByPriority: KeysByPriority;

    // Партиции, отдавшие последнюю задачу. Удалить их можно не раньше, чем истечёт остывание,
    // а истечение — не событие, поэтому голову набора проверяет pull().
    private readonly idleKeys: Set<TaskKey>;

    private readonly commonLimit: RateLimit;

    private banExpirationTime: number | null = null;

    private taskCount = 0;

    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        this.partitions = new Map<TaskKey, Partition>();
        this.keysByPriority = {
            [PRIORITY.HIGH]: new Set<TaskKey>(),
            [PRIORITY.MEDIUM]: new Set<TaskKey>(),
            [PRIORITY.LOW]: new Set<TaskKey>(),
        };
        this.idleKeys = new Set<TaskKey>();
        this.commonLimit = new RateLimit(this.commonRate);

        this.logTaskCount();
        this.logBanExpires();
    }

    public push(task: Task, priority: PRIORITY): void {
        let partition = this.partitions.get(task.key);

        if (!partition) {
            partition = new Partition(task.rate);
            this.partitions.set(task.key, partition);
        }

        partition.push(task, priority);
        this.keysByPriority[priority].add(task.key);
        this.idleKeys.delete(task.key);
        this.taskCount++;
    }

    public pull(): Task | null {
        this.removeIdlePartitions();

        if (this.isBanned()) {
            return null;
        }

        if (this.isEmpty()) {
            return null;
        }

        if (!this.commonLimit.isFree()) {
            return null;
        }

        for (const priority of Object.values(PRIORITY)) {
            const task = this.pullByPriority(priority);

            if (task) {
                return task;
            }
        }

        return null;
    }

    public isEmpty(): boolean {
        return this.taskCount === 0;
    }

    public getTaskCount(): number {
        return this.taskCount;
    }

    public ban(duration: number): void {
        const expirationTime = duration + Date.now();

        if (expirationTime < Date.now()) {
            return;
        }

        this.banExpirationTime = expirationTime;
    }

    private isBanned(): boolean {
        return this.banExpirationTime !== null && this.banExpirationTime >= Date.now();
    }

    // Ключ, у которого лимит ещё не остыл, пропускается: голова очереди не держит остальных.
    private pullByPriority(priority: PRIORITY): Task | null {
        const keys = this.keysByPriority[priority];

        for (const key of keys) {
            const partition = this.partitions.get(key);

            if (!partition) {
                keys.delete(key);
                continue;
            }

            if (!partition.isFree()) {
                continue;
            }

            const task = partition.take(priority);

            if (!task) {
                keys.delete(key);
                continue;
            }

            this.commonLimit.reserve();
            this.taskCount--;

            if (!partition.has(priority)) {
                keys.delete(key);
            }

            if (partition.isEmpty()) {
                this.idleKeys.add(key);
            }

            return task;
        }

        return null;
    }

    // Обход обрывается на первой ещё остывающей партиции, поэтому работа пропорциональна числу
    // удалённых, а не размеру Map. Остывающая голова задерживает уборку не дольше собственного
    // остывания — набор хранит ключи в порядке опустошения.
    private removeIdlePartitions(): void {
        for (const key of this.idleKeys) {
            const partition = this.partitions.get(key);

            if (!partition) {
                this.idleKeys.delete(key);
                continue;
            }

            if (!partition.isEmpty()) {
                this.idleKeys.delete(key);
                continue;
            }

            if (!partition.isFree()) {
                break;
            }

            this.partitions.delete(key);
            this.idleKeys.delete(key);
        }
    }

    private logTaskCount(): void {
        setInterval(() => {
            this.logger.info(`Number of tasks in the queue: ${this.taskCount}. Number of partitions: ${this.partitions.size}`);
        }, 10000).unref();
    }

    private logBanExpires(): void {
        setInterval(() => {
            if (this.banExpirationTime && this.isBanned()) {
                const banExpires = Math.floor((this.banExpirationTime - Date.now()) / 1000);
                console.log(`Ban expires in ${banExpires} second.`);
            }
        }, 10000).unref();
    }
}
