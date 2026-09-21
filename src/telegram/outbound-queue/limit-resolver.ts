import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { Task } from "app/telegram/outbound-queue/task";

// The limit belongs to the partition, so the queue asks for it once — when it creates the
// partition on the first task of the key. The rule that picks the limit belongs to the side using
// the queue and may lean on anything in the task, so the whole task goes in here, not just the
// key.
export interface LimitResolver {
    resolve(task: Task): Limit;
}
