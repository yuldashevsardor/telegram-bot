export type InboxMaintenanceSettings = {
    // How often a node takes back the updates of the expired leases.
    leaseRecoveryIntervalMs: number;
    // How often a node runs the cleanup.
    cleanupIntervalMs: number;
    // How often a node counts the blocked groups and, while there are any, writes the error line.
    blockedLogIntervalMs: number;
};
