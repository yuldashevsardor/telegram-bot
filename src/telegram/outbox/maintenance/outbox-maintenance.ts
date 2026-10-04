import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { OutboxLeaseRecovery } from "app/telegram/outbox/lease/outbox-lease-recovery";
import type { OutboxMaintenanceSettings } from "app/telegram/outbox/maintenance/outbox-maintenance.types";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";

type MaintenanceTask = {
    name: string;
    intervalMs: number;
    run: () => Promise<void>;
};

// The timers of a node besides the sending: the recovery of the expired leases, the cleanup and the
// status line (docs/architecture/outbox.md, "Maintenance").
@injectable()
export class OutboxMaintenance {
    private isStopped = false;
    private readonly timers = new Set<NodeJS.Timeout>();
    private readonly runsInProgress = new Set<Promise<void>>();

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxLeaseRecovery>(Tokens.Bot.Outbox.Lease.Recovery) private readonly leaseRecovery: OutboxLeaseRecovery,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly settings: OutboxMaintenanceSettings = configValue("outbox.maintenance"),
    ) {}

    // Each task runs first one interval after the start. The next run is timed from the end of the
    // previous one, so two runs of a task never overlap.
    public start(): void {
        const tasks: MaintenanceTask[] = [
            {
                name: "recoverLeases",
                intervalMs: this.settings.leaseRecoveryIntervalMs,
                run: () => this.leaseRecovery.recover(),
            },
            {
                name: "deleteFinishedMessages",
                intervalMs: this.settings.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteFinishedMessages()),
            },
            {
                name: "deleteIdleChats",
                intervalMs: this.settings.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteIdleChats()),
            },
            {
                name: "logStatus",
                intervalMs: this.settings.statusLogIntervalMs,
                run: () => this.logStatus(),
            },
        ];

        for (const task of tasks) {
            this.schedule(task);
        }
    }

    // Clears the timers and waits for the runs in progress: the database is closed after the stop.
    public async stop(): Promise<void> {
        this.isStopped = true;

        for (const timer of this.timers) {
            clearTimeout(timer);
        }

        // Stryker disable next-line CallExpression: `;` (the call deleted) is equivalent: nothing reads the set after the stop: schedule() returns on isStopped and the cleared timers never fire.
        this.timers.clear();
        await Promise.all(this.runsInProgress);
    }

    private schedule(task: MaintenanceTask): void {
        if (this.isStopped) {
            return;
        }

        const timer = setTimeout(() => {
            // Stryker disable next-line CallExpression: `;` (the call deleted) is equivalent: stop() reads the set only to clear its timers, and clearing a timer that has fired does nothing, so what the call keeps out is the growth of the set by one entry per run, which only a read of the private set sees
            this.timers.delete(timer);
            const runInProgress = this.runTask(task).finally(() => {
                // Stryker disable next-line CallExpression: `;` (the call deleted) is equivalent: stop() reads the set only to await its runs, and a run that has settled is awaited at once, so what the call keeps out is the growth of the set by one entry per run, which only a read of the private set sees
                this.runsInProgress.delete(runInProgress);
                this.schedule(task);
            });
            this.runsInProgress.add(runInProgress);
        }, task.intervalMs);

        this.timers.add(timer);
    }

    // A failed run is left to the next one.
    private async runTask(task: MaintenanceTask): Promise<void> {
        try {
            await task.run();
        } catch (error) {
            this.logger.error("An outbox maintenance task failed, its next run tries again.", { task: task.name, cause: error });
        }
    }

    // A batch may leave more behind it, so the next one follows at once until one deletes nothing.
    // Not until one is short of the batch size: that is the LIMIT of the store, and a copy of it here
    // could differ. The cost is one empty batch per run. The stop ends the repetition: the rest is
    // left to the cleanup of another node or of the next start.
    private async deleteInBatches(deleteBatch: () => Promise<number>): Promise<void> {
        while (!this.isStopped) {
            const deletedCount = await deleteBatch();

            if (deletedCount === 0) {
                return;
            }
        }
    }

    // The counts come from the tables, so a node writes the state of the whole outbox, not of its own
    // sends.
    private async logStatus(): Promise<void> {
        const backlog = await this.store.readBacklog();

        this.logger.info("Outbox status.", backlog);
    }
}
