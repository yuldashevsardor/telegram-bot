import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxLease } from "app/telegram/inbox/store/inbox-store.types";

// Extends the lease of one update while its handler runs (docs/architecture/inbox.md, "The update
// processor"). Each extension is timed from the end of the previous one, so two never overlap. A
// refused one ends the extension: the lease has passed or gone to another claim, and the completion
// will be fenced. A failed one is left to the next. The abort of the signal ends it too: the stop has
// given the update up, and the database is closed after the stop.
export class InboxLeaseExtension {
    private timer: NodeJS.Timeout | undefined;
    private isStopped = false;

    public constructor(
        private readonly store: InboxStore,
        private readonly logger: Logger,
        private readonly lease: InboxLease,
        private readonly intervalMs: number,
        private readonly signal: AbortSignal,
    ) {}

    public start(): void {
        this.signal.addEventListener("abort", () => this.stop());
        this.schedule();
    }

    // An extension in flight is let finish, and its answer is dropped.
    public stop(): void {
        this.isStopped = true;
        clearTimeout(this.timer);
    }

    private schedule(): void {
        if (this.isStopped || this.signal.aborted) {
            return;
        }

        this.timer = setTimeout(() => void this.extend(), this.intervalMs);
    }

    private async extend(): Promise<void> {
        let isExtended: boolean;

        try {
            isExtended = await this.store.extendLease(this.lease);
        } catch (error) {
            if (!this.isStopped) {
                this.logWarning("Extending the lease of an inbox update failed, the next extension tries again.", {
                    updateId: this.lease.updateId,
                    cause: error,
                });
            }

            this.schedule();
            return;
        }

        if (this.isStopped) {
            return;
        }

        if (!isExtended) {
            this.logWarning("The lease of an inbox update was not extended: it has passed or gone to another claim.", {
                updateId: this.lease.updateId,
            });
            return;
        }

        this.schedule();
    }

    // extend() runs from a timer, and nothing awaits it: a log that throws would reject it unhandled,
    // and unhandledRejection ends the process (src/app.ts). The failure of the log itself has nowhere
    // left to go.
    private logWarning(message: string, payload: UnknownObject): void {
        try {
            this.logger.warning(message, payload);
        } catch {
            return;
        }
    }
}
