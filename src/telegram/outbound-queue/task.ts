export enum Priority {
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}

export type PartitionKey = string | number;

export type Task = {
    key: PartitionKey;
    priorityOnError: Priority;
    callback: () => Promise<unknown>;
    retryCount?: number;
};
