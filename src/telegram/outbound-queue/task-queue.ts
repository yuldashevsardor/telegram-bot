import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import { Partition } from "app/telegram/outbound-queue/partition";
import { RateLimit } from "app/telegram/outbound-queue/rate-limit";
import type { Limit } from "app/telegram/outbound-queue/rate-limit.types";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";

type KeysByPriority = {
    [key in Priority]: Set<PartitionKey>;
};

@injectable()
export class TaskQueue {
    // Потолок на один pull(): партиции копятся не быстрее, чем общий лимит отдаёт задачи, но
    // уборка не должна зависеть от настроек лимитов — после всплеска накопленное снимается
    // за несколько вызовов, а не одним проходом по событийному циклу.
    private static readonly REMOVED_PARTITIONS_PER_PULL = 100;

    private readonly partitions: Map<PartitionKey, Partition>;

    // Индекс «у кого есть задачи этого приоритета»: без него поиск очередной задачи означал бы
    // обход всех партиций. Set хранит ключи в порядке вставки, он же задаёт очерёдность ключей
    // внутри приоритета.
    private readonly keysByPriority: KeysByPriority;

    // Партиции, отдавшие последнюю задачу. Удалить их можно не раньше, чем истечёт остывание,
    // а истечение — не событие, поэтому голову набора проверяет pull().
    private readonly idleKeys: Set<PartitionKey>;

    private readonly commonLimit: RateLimit;

    private banExpirationTime: number | null = null;

    private taskCount = 0;

    public constructor(
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        @inject<LimitResolver>(Tokens.Bot.OutboundQueue.LimitResolver) private readonly limitResolver: LimitResolver,
        commonLimitSettings: Limit = configValue("limits.common"),
        private readonly logInterval: number = configValue("taskQueue.logInterval"),
    ) {
        this.partitions = new Map<PartitionKey, Partition>();
        this.keysByPriority = {
            [Priority.HIGH]: new Set<PartitionKey>(),
            [Priority.MEDIUM]: new Set<PartitionKey>(),
            [Priority.LOW]: new Set<PartitionKey>(),
        };
        this.idleKeys = new Set<PartitionKey>();
        this.commonLimit = new RateLimit(commonLimitSettings);

        this.logTaskCount();
        this.logBanExpires();
    }

    public push(task: Task, priority: Priority): void {
        let partition = this.partitions.get(task.key);

        if (!partition) {
            partition = new Partition(this.limitResolver.resolve(task));
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

        // Stryker disable next-line ConditionalExpression,BlockStatement: `false` и `{}` — эквивалентны: без задач наборы keysByPriority пусты, и обход ниже вернёт тот же null
        if (this.isEmpty()) {
            return null;
        }

        if (!this.commonLimit.isFree()) {
            return null;
        }

        for (const priority of Object.values(Priority)) {
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

    public getPartitionCount(): number {
        return this.partitions.size;
    }

    public ban(duration: number): void {
        const expirationTime = duration + Date.now();

        // Stryker disable next-line EqualityOperator: `<=` — эквивалентен: расходится только на ban(0) при действующей паузе, а Runner нулевой паузы не ставит — retry_after ≤ 0 он заменяет DEFAULT_RETRY_AFTER_SECONDS
        if (expirationTime < Date.now()) {
            return;
        }

        this.banExpirationTime = expirationTime;
    }

    private isBanned(): boolean {
        // Stryker disable next-line ConditionalExpression,EqualityOperator: `true` слева от `&&` — не компилируется: banExpirationTime может быть null; `>` — эквивалентен: пауза кончается на миллисекунду раньше, а retry_after соблюдают оба варианта
        return this.banExpirationTime !== null && this.banExpirationTime >= Date.now();
    }

    // Ключ, у которого лимит ещё не остыл, пропускается: голова очереди не держит остальных.
    private pullByPriority(priority: Priority): Task | null {
        const keys = this.keysByPriority[priority];

        for (const key of keys) {
            // Ключ лежит в наборе, только пока у его партиции есть задачи этого приоритета: push()
            // кладёт его вместе с задачей, выемка ниже убирает, когда корзина опустела, а forgetKey()
            // снимает отовсюду вместе с партицией. Поэтому null из take() значит одно — лимит ключа
            // ещё не остыл. Проверок на обратное нет: ключ без партиции уронит процесс через
            // uncaughtException, а ключ без задач молча пропускается на каждом pull(), пока жива партиция,
            // и держит старое место в наборе: add() в push() его не переставит, и новая задача ключа
            // обгонит ключи, вставшие в очередь раньше.
            const partition = this.partitions.get(key) as Partition;
            const task = partition.take(priority);

            if (!task) {
                continue;
            }

            this.commonLimit.reserve();
            this.taskCount--;

            // Ключ уходит в хвост набора (Set хранит порядок вставки), иначе ключи, успевающие
            // остыть за время обхода, занимают голову бесконечно, и до остальных очередь не
            // доходит: при общем лимите 30/1000 мс и приватном 3/1000 мс так обслуживались бы
            // только первые десять ключей.
            keys.delete(key);

            if (partition.has(priority)) {
                keys.add(key);
            }

            if (partition.isEmpty()) {
                this.idleKeys.add(key);
            }

            return task;
        }

        return null;
    }

    // Обход обрывается на первой ещё остывающей партиции, поэтому работа пропорциональна числу
    // снятых ключей, а не размеру набора. Набор общий для всех остываний, поэтому голова с долгим
    // остыванием (группа — 3 с) задерживает за собой и уже остывшие приватные партиции: их отпустит
    // тот pull(), на котором остынет она сама. Число таких задержанных ограничено общим лимитом —
    // при дефолтах это меньше сотни, — а память они занимают ту же, что и до опустошения.
    private removeIdlePartitions(): void {
        let removed = 0;

        for (const key of this.idleKeys) {
            if (removed >= TaskQueue.REMOVED_PARTITIONS_PER_PULL) {
                break;
            }

            // В idleKeys ключ попадает с опустевшей партицией, а push() и forgetKey() его оттуда
            // снимают, поэтому партиция здесь есть и пуста — ждать осталось только остывания. Проверки
            // пустоты нет: правка, оставившая здесь непустую партицию, молча выбросит её задачи, а
            // taskCount до нуля уже не дойдёт, и остановка прождёт весь срок разгрузки очереди.
            const partition = this.partitions.get(key) as Partition;

            if (!partition.isFree()) {
                break;
            }

            this.forgetKey(key);
            removed++;
        }
    }

    // Ключ уходит сразу из всех наборов: индекс приоритетов чистится и по ходу выемки, но так
    // условие «в keysByPriority нет ключей без партиции» держится в одном месте, а не выводится
    // из того, что опустевшая корзина всегда успевает выбыть из индекса раньше.
    private forgetKey(key: PartitionKey): void {
        this.partitions.delete(key);
        this.idleKeys.delete(key);

        // Stryker disable next-line BlockStatement: `{}` — эквивалентен: сюда доходит только пустая партиция, а её ключ выемка уже сняла с индекса
        for (const keys of Object.values(this.keysByPriority)) {
            // Stryker disable next-line CallExpression: удаление вызова — эквивалентно: сюда доходит только пустая партиция, а её ключ выемка уже сняла с индекса
            keys.delete(key);
        }
    }

    private logTaskCount(): void {
        setInterval(() => {
            this.logger.info(`Number of tasks in the queue: ${this.taskCount}. Number of partitions: ${this.getPartitionCount()}`);
        }, this.logInterval).unref();
    }

    private logBanExpires(): void {
        setInterval(() => {
            if (this.banExpirationTime && this.isBanned()) {
                this.logger.info(`Ban expires in ${Math.floor((this.banExpirationTime - Date.now()) / 1000)} second.`);
            }
        }, this.logInterval).unref();
    }
}
