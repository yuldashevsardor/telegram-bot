export type OutboxResultWaiterSettings = {
    // How long a caller waits for the outcome of its message.
    timeoutMs: number;
    // How often the ids still waited for are looked up, in case their notification was lost.
    pollIntervalMs: number;
};
