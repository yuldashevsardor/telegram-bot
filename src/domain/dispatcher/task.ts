import { Rate } from "app/domain/dispatcher/rate-limit";

export enum PRIORITY {
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}

export type TaskKey = string | number;

// Лимит несёт сама задача: Dispatcher не знает, приватный это чат, группа или вообще не чат,
// и выбор лимита остаётся у того, кто задачу ставит.
export type Task = {
    key: TaskKey;
    rate: Rate;
    priorityOnError: PRIORITY;
    callback: () => Promise<unknown>;
    retryCount?: number;
};
