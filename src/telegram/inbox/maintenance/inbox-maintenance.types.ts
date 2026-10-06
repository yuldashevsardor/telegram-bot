export type InboxMaintenanceSettings = {
    // How often a node takes back the updates of the expired leases.
    leaseRecoveryIntervalMs: number;
    // How often a node runs the cleanup.
    cleanupIntervalMs: number;
};
