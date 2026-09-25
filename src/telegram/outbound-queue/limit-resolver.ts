import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { Task } from "app/telegram/outbound-queue/task";

// The queue asks for the limit once, when it creates the partition on the first task of the key:
// the limit belongs to the partition. The rule that picks it belongs to the side using the queue and
// may read anything in the task, so it gets the whole task, not just the key.
export interface LimitResolver {
    resolve(task: Task): Limit;
}
