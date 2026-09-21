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

    // The partition reserves by itself: the limit of a key exists only to give out its tasks, and
    // splitting the take and the reservation into different calls would let a task be taken without
    // occupying the slot. Both checks run before the take, so reserve() here does not throw
    // RateLimitIsBusy: nothing asynchronous happens between the check and the reservation.
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

    // An empty and cooled down partition is indistinguishable from a freshly created one, so it can
    // be removed. While the cooldown lasts, the partition is the limit of the key: removing it would
    // give out the next task of that key immediately, past the limit.
    public isIdle(): boolean {
        return this.isEmpty() && this.isFree();
    }

    public get size(): number {
        return this.count;
    }
}
