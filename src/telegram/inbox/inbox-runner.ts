import os from "os";
import { randomUUID } from "crypto";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { withTimeout } from "app/shared/utils";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { InboxUpdateSource } from "app/telegram/inbox/inbox-update-source";
import type { InboxUpdateProcessor } from "app/telegram/inbox/inbox-update-processor";
import type { ClaimedInboxUpdate, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";

// An update in flight: its promise settles once the processor has written its outcome or released
// it, and never rejects.
type HandlingInFlight = {
    updateId: number;
    settled: Promise<void>;
};

// The handling of a node: one loop over a number of slots, each handling one update at a time
// (docs/architecture/inbox.md, "The runner"). The runner writes no outcome: the processor does.
@injectable()
export class InboxRunner {
    // An update in flight by the controller that aborts it.
    private readonly handlingsInFlight = new Map<AbortController, HandlingInFlight>();
    // Ends the latest wait of a loop with every slot busy: an update that settles or the stop calls
    // it, and a call after the wait has ended changes nothing. One resolver per wait, for the reason
    // OutboxRunner gives.
    private wakeUpLoop: (() => void) | undefined;
    private isStopping = false;
    // When stop() gives up waiting for the handlers in flight; none before the stop.
    private stopDeadlineAtMs = Number.POSITIVE_INFINITY;
    private runCompletion: Promise<void> = Promise.resolve();

    public constructor(
        @inject<InboxUpdateSource>(Tokens.Bot.Inbox.UpdateSource) private readonly source: InboxUpdateSource,
        @inject<InboxUpdateProcessor>(Tokens.Bot.Inbox.UpdateProcessor) private readonly processor: InboxUpdateProcessor,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly concurrency: number = configValue("inbox.concurrency"),
        private readonly stopTimeoutMs: number = configValue("inbox.stopTimeoutMs"),
        // Goes into every attempt this loop makes: the node, and the loop among the restarts of the
        // process.
        private readonly worker: InboxWorker = { host: os.hostname(), pid: process.pid, workerId: randomUUID() },
    ) {}

    // Called once: the source serves one generator (docs/architecture/invariants.md, "The inbox").
    public start(): void {
        this.runCompletion = this.run();
    }

    // Stops taking updates and waits for the handlers in flight up to stopTimeoutMs from the call.
    // A handler cannot be cut short: the ones still running then are aborted, which ends the
    // extension of their lease, and left to run on. Each writes its outcome if it settles while the
    // database is open; otherwise the recovery takes its update back after the lease.
    public async stop(): Promise<void> {
        this.stopDeadlineAtMs = Date.now() + this.stopTimeoutMs;
        this.isStopping = true;
        this.wakeUpLoop?.();
        this.source.stop();

        // A claim in progress hands out its update before the loop ends, and the loop starts it: left
        // unhandled, the update would wait for the recovery of its lease. Past the deadline it starts
        // aborted, and the processor releases it (startHandling()).
        await this.runCompletion;

        const handlingsSettled = Promise.all([...this.handlingsInFlight.values()].map((handling) => handling.settled));
        const haveHandlingsSettled = await withTimeout(handlingsSettled, this.stopDeadlineAtMs - Date.now());

        if (haveHandlingsSettled) {
            return;
        }

        const unsettledUpdateIds: number[] = [];

        for (const [abortController, handling] of this.handlingsInFlight) {
            abortController.abort();
            unsettledUpdateIds.push(handling.updateId);
        }

        this.logger.warning(
            "The inbox runner stopped with handlers still running, their updates wait for their own outcome or the lease.",
            {
                updateIds: unsettledUpdateIds,
            },
        );
    }

    // Catches what the source throws: the rejection of an unawaited run() would reach
    // unhandledRejection, which ends the process (src/app.ts).
    private async run(): Promise<void> {
        try {
            for await (const update of this.source.stream(this.worker)) {
                this.startHandling(update);
                await this.waitForFreeSlotOrStop();

                if (this.isStopping) {
                    return;
                }
            }
        } catch (error) {
            this.logError("The inbox update source failed, the runner takes no more updates.", { cause: error });
        }
    }

    // Returns at once while a slot is free.
    private async waitForFreeSlotOrStop(): Promise<void> {
        while (!this.isStopping && this.handlingsInFlight.size >= this.concurrency) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.wakeUpLoop = resolve;

            await promise;
        }
    }

    // An update claimed is started at once: its lease counts from the claim.
    private startHandling(update: ClaimedInboxUpdate): void {
        const abortController = new AbortController();

        // A claim in progress at the stop handed the update out after the deadline: started aborted,
        // it is released without reaching its handler.
        if (Date.now() >= this.stopDeadlineAtMs) {
            abortController.abort();
        }

        const settled = this.handle(update, abortController.signal).finally(() => {
            this.handlingsInFlight.delete(abortController);
            this.wakeUpLoop?.();
        });

        this.handlingsInFlight.set(abortController, { updateId: update.updateId, settled: settled });
    }

    // Never rejects: an async function turns a synchronous throw of process() into a rejection, and
    // the catch takes it.
    private async handle(update: ClaimedInboxUpdate, signal: AbortSignal): Promise<void> {
        try {
            await this.processor.process(update, signal);
        } catch (error) {
            this.logError("An inbox update was not completed, the recovery of its lease takes it back.", {
                updateId: update.updateId,
                cause: error,
            });
        }
    }

    // A log that throws, say on a payload its serializer refuses, would reject a promise nobody
    // handles, and unhandledRejection ends the process (src/app.ts). There is nowhere left to report
    // the failure of the log itself.
    private logError(message: string, payload: UnknownObject): void {
        try {
            this.logger.error(message, payload);
        } catch {
            return;
        }
    }
}
