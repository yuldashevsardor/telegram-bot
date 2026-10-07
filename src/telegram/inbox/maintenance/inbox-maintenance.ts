import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import type { InboxMaintenanceSettings } from "app/telegram/inbox/maintenance/inbox-maintenance.types";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";

type MaintenanceTask = {
    name: string;
    intervalMs: number;
    run: () => Promise<void>;
};

// The timers of a node besides the handling: the recovery of the expired leases, the cleanup and the
// line of the blocked groups (docs/architecture/inbox.md, "Maintenance").
@injectable()
export class InboxMaintenance {
    private isStopped = false;
    private readonly timers = new Set<NodeJS.Timeout>();
    private readonly runsInProgress = new Set<Promise<void>>();

    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<InboxFailureHandler>(Tokens.Bot.Inbox.FailureHandler) private readonly failureHandler: InboxFailureHandler,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly settings: InboxMaintenanceSettings = configValue("inbox.maintenance"),
    ) {}

    // Each task runs first one interval after the start. The next run is timed from the end of the
    // previous one, so two runs of a task never overlap.
    public start(): void {
        const tasks: MaintenanceTask[] = [
            {
                name: "recoverExpiredLeases",
                intervalMs: this.settings.leaseRecoveryIntervalMs,
                run: () => this.failureHandler.recoverExpiredLeases(),
            },
            {
                name: "deleteFinishedUpdates",
                intervalMs: this.settings.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteFinishedUpdates()),
            },
            {
                name: "deleteIdleGroups",
                intervalMs: this.settings.cleanupIntervalMs,
                run: () => this.deleteInBatches(() => this.store.deleteIdleGroups()),
            },
            {
                name: "logBlockedGroups",
                intervalMs: this.settings.blockedLogIntervalMs,
                run: () => this.logBlockedGroups(),
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
            this.logger.error("An inbox maintenance task failed, its next run tries again.", { task: task.name, cause: error });
        }
    }

    // A batch may leave more behind it, so the next one follows at once until one deletes nothing,
    // as in OutboxMaintenance. The stop ends the repetition: the rest is left to the cleanup of
    // another node or of the next start.
    private async deleteInBatches(deleteBatch: () => Promise<number>): Promise<void> {
        while (!this.isStopped) {
            const deletedCount = await deleteBatch();

            if (deletedCount === 0) {
                return;
            }
        }
    }

    // A blocked group waits for a person, so the line is an error, as in OutboxMaintenance.
    private async logBlockedGroups(): Promise<void> {
        const blockedGroupCount = await this.store.countBlockedGroups();

        if (blockedGroupCount === 0) {
            return;
        }

        this.logger.error(
            'Inbox groups are blocked: find them and unblock each with make inbox-retry user=<id> chat=<id> or make inbox-skip user=<id> chat=<id> (README.md, "Unblocking a chat or a group").',
            {
                blockedGroupCount: blockedGroupCount,
            },
        );
    }
}
