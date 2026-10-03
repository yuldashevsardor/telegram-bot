import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";

type MaintenanceTask = {
    name: string;
    intervalMs: number;
    run: () => Promise<void>;
};

// The timers of a node besides the sending: the recovery of the expired leases and the cleanup
// (docs/architecture/outbox.md, "Maintenance").
@injectable()
export class OutboxMaintenance {
    private isStopped = false;
    private readonly timers = new Set<NodeJS.Timeout>();
    private readonly runsInProgress = new Set<Promise<void>>();

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxFailureHandler>(Tokens.Bot.Outbox.FailureHandler) private readonly failureHandler: OutboxFailureHandler,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly leaseRecoveryIntervalMs: number = configValue("outbox.leaseRecoveryIntervalMs"),
        private readonly cleanupIntervalMs: number = configValue("outbox.cleanupIntervalMs"),
        private readonly cleanupBatchSize: number = configValue("outbox.cleanup.batchSize"),
    ) {}

    // Each task runs first one interval after the start. The next run is timed from the end of the
    // previous one, so two runs of a task never overlap.
    public start(): void {
        const tasks: MaintenanceTask[] = [
            {
                name: "recoverExpiredLeases",
                intervalMs: this.leaseRecoveryIntervalMs,
                run: () => this.failureHandler.recoverExpiredLeases(),
            },
            {
                name: "deleteFinishedMessages",
                intervalMs: this.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteFinishedMessages()),
            },
            {
                name: "deleteIdleChats",
                intervalMs: this.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteIdleChats()),
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

        this.timers.clear();
        await Promise.all(this.runsInProgress);
    }

    private schedule(task: MaintenanceTask): void {
        if (this.isStopped) {
            return;
        }

        const timer = setTimeout(() => {
            this.timers.delete(timer);
            const runInProgress = this.runTask(task).finally(() => {
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

    // A full batch may leave more behind it, so the next one follows at once. The stop ends the
    // repetition: the rest is left to the cleanup of another node or of the next start.
    private async deleteInBatches(deleteBatch: () => Promise<number>): Promise<void> {
        while (!this.isStopped) {
            const deletedCount = await deleteBatch();

            if (deletedCount < this.cleanupBatchSize) {
                return;
            }
        }
    }
}
