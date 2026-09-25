import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import { Partition } from "app/telegram/outbound-queue/partition";
import { RateLimit } from "app/telegram/outbound-queue/rate-limit/rate-limit";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { PartitionKey, Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";

type KeysByPriority = {
    [key in Priority]: Set<PartitionKey>;
};

@injectable()
export class TaskQueue {
    // The most partitions one pull() removes. The common limit already caps how fast partitions pile
    // up, but the cleanup must not depend on the limit settings. After a burst the backlog is removed
    // over several calls, not in one pass of the event loop.
    private static readonly REMOVED_PARTITIONS_PER_PULL = 100;

    private readonly partitions: Map<PartitionKey, Partition>;

    // Which keys have tasks of each priority. Without this index, finding the next task would walk
    // every partition. A Set keeps insertion order, and that order is the turn of the keys inside a
    // priority.
    private readonly keysByPriority: KeysByPriority;

    // The keys whose partition has given out its last task. The partition cannot be removed before
    // its cooldown expires, and an expiry is not an event, so pull() checks the head of the set.
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

        // Stryker disable next-line ConditionalExpression,BlockStatement: `false` and `{}` are equivalent: with no tasks the keysByPriority sets are empty, and the walk below returns the same null
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

        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it diverges only on a pause that expires by the check right here — ban(0) or ban(1) on a millisecond change — while Runner sets no less than a second: retry_after in the Bot API is an integer, and a value <= 0 is replaced by DEFAULT_RETRY_AFTER_SECONDS
        if (expirationTime < Date.now()) {
            return;
        }

        this.banExpirationTime = expirationTime;
    }

    private isBanned(): boolean {
        // Stryker disable next-line EqualityOperator: `>` is equivalent: the pause ends a millisecond earlier, and both variants respect retry_after
        return this.banExpirationTime !== null && this.banExpirationTime >= Date.now();
    }

    // A key whose limit has not cooled down is skipped, so the head of the queue does not hold back
    // the rest.
    private pullByPriority(priority: Priority): Task | null {
        const keys = this.keysByPriority[priority];

        for (const key of keys) {
            // A key is in the set only while its partition has tasks of this priority. push() adds it
            // with the task, the take below removes it once the bucket is empty, and forgetKey() removes
            // it with the partition. So a null from take() means only that the limit of the key has not
            // cooled down. The opposite cases are not checked:
            // - a key without a partition kills the process through uncaughtException;
            // - a key without tasks is silently skipped on every pull() while the partition lives. It
            //   keeps its old place in the set, because add() in push() does not move it, so a new task
            //   of that key would overtake the keys that queued earlier.
            const partition = this.partitions.get(key) as Partition;
            const task = partition.take(priority);

            if (!task) {
                continue;
            }

            this.commonLimit.reserve();
            this.taskCount--;

            // The key goes to the tail of the set (a Set keeps insertion order). Otherwise the keys that
            // cool down during a walk would hold the head forever and the rest would never be served:
            // with a common limit of 30/1000 ms and a private one of 3/1000 ms, only the first ten keys.
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

    // The walk stops at the first partition still cooling down, so its cost follows the number of keys
    // removed, not the size of the set. The set is shared by all cooldowns. A head with a long one (a
    // group, 3 s) holds back the cooled-down private partitions behind it until the pull() on which
    // the head itself cools down. The common limit bounds how many are held back: under the defaults,
    // fewer than a hundred. They take the same memory as before they were emptied.
    private removeIdlePartitions(): void {
        let removed = 0;

        for (const key of this.idleKeys) {
            if (removed >= TaskQueue.REMOVED_PARTITIONS_PER_PULL) {
                break;
            }

            // A key enters idleKeys with an emptied partition, and push() and forgetKey() take it out. So
            // the partition here exists and is empty, and only the cooldown is left to wait for. There is
            // no emptiness check. A change that left a non-empty partition here would silently throw away
            // its tasks: taskCount would never reach zero, and the shutdown would wait out the whole drain
            // timeout of the queue.
            const partition = this.partitions.get(key) as Partition;

            if (!partition.isFree()) {
                break;
            }

            this.forgetKey(key);
            removed++;
        }
    }

    // The key leaves every set at once. The take also removes it from the priority index, but this way
    // "keysByPriority holds no keys without a partition" is kept in one place, instead of relying on
    // every emptied bucket leaving the index in time.
    private forgetKey(key: PartitionKey): void {
        this.partitions.delete(key);
        this.idleKeys.delete(key);

        // Stryker disable next-line BlockStatement: `{}` is equivalent while the take strips the key of an emptied bucket from the index: only an empty partition reaches this point
        for (const keys of Object.values(this.keysByPriority)) {
            // Stryker disable next-line CallExpression: dropping the call is equivalent while the take strips the key of an emptied bucket from the index: only an empty partition reaches this point
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
