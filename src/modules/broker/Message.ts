export enum PRIORITY {
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}

export const DEFAULT_PRIORITY = PRIORITY.MEDIUM;

export type Message = {
    chatId: number;
    isGroup: boolean;
    priorityOnError: PRIORITY;
    callback: () => Promise<unknown>;
};
