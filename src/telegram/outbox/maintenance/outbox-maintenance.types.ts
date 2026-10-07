export type OutboxMaintenanceSettings = {
    // How often a node takes back the messages of the expired leases.
    leaseRecoveryIntervalMs: number;
    // How often a node runs the cleanup.
    cleanupIntervalMs: number;
    // How often a node writes the status line of the outbox.
    statusLogIntervalMs: number;
    // How often a node counts the blocked chats and, while there are any, writes the error line.
    blockedLogIntervalMs: number;
};
