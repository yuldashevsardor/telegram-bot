import { RateLimit } from "app/telegram/outbound-queue/rate-limit/rate-limit";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";

type PartitionTasks = {
    [key in Priority]: Task[];
};

export class Partition {
    private readonly tasks: PartitionTasks;

    private readonly rateLimit: RateLimit;

    private count = 0;

    public constructor(limit: Limit) {
        this.tasks = {
            [Priority.HIGH]: [],
            [Priority.MEDIUM]: [],
            [Priority.LOW]: [],
        };

        this.rateLimit = new RateLimit(limit);
    }

    public push(task: Task, priority: Priority): void {
        this.tasks[priority].push(task);
        this.count++;
    }

    // take() reserves the limit of the key itself: the limit exists only to give out the tasks of
    // the key. A separate reservation call would let a task be taken without occupying the slot.
    // reserve() here does not throw RateLimitIsBusy: both checks run before the take, and nothing
    // asynchronous happens between the check and the reservation.
    public take(priority: Priority): Task | null {
        if (!this.has(priority) || !this.isFree()) {
            return null;
        }

        this.rateLimit.reserve();
        this.count--;

        return this.tasks[priority].shift() as Task;
    }

    public has(priority: Priority): boolean {
        return this.tasks[priority].length > 0;
    }

    public isEmpty(): boolean {
        return this.count === 0;
    }

    public isFree(): boolean {
        return this.rateLimit.isFree();
    }

    // An empty, cooled-down partition is no different from a new one, so it can be removed. While the
    // cooldown lasts, the partition is the limit of the key: removing it would let the next task of
    // that key out at once, past the limit.
    public isIdle(): boolean {
        return this.isEmpty() && this.isFree();
    }

    public get size(): number {
        return this.count;
    }
}
