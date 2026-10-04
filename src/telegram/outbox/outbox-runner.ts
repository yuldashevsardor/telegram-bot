import os from "os";
import { randomUUID } from "crypto";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { withTimeout } from "app/shared/utils";
import type { Logger } from "app/platform/logger/logger";
import type { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import type { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import type { OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The sending of a node: one loop over a number of slots, each sending one message at a time
// (docs/architecture/outbox.md, "The runner"). The runner writes no outcome: the processor does.
@injectable()
export class OutboxRunner {
    // A call in flight by the controller that aborts it; the promise settles once the processor has
    // written its outcome or released it, and never rejects.
    private readonly callsInFlight = new Map<AbortController, Promise<void>>();
    // Ends the latest wait of a loop with every slot busy: a call that settles or the stop calls it,
    // and a call after the wait has ended changes nothing. One resolver per wait: a race with a
    // promise pending until the stop would leave a reaction on it per wait, and the heap would grow
    // with every message sent.
    private wakeUpRunner: (() => void) | undefined;
    private isStopping = false;
    // When stop() aborts the calls in flight; none before the stop.
    private stopDeadlineAtMs = Number.POSITIVE_INFINITY;
    private runCompletion: Promise<void> = Promise.resolve();

    public constructor(
        @inject<OutboxMessageSource>(Tokens.Bot.Outbox.MessageSource) private readonly source: OutboxMessageSource,
        @inject<OutboxMessageProcessor>(Tokens.Bot.Outbox.MessageProcessor) private readonly processor: OutboxMessageProcessor,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly concurrency: number = configValue("outbox.concurrency"),
        private readonly stopTimeoutMs: number = configValue("outbox.stopTimeoutMs"),
        // Goes into every attempt this loop makes: the node, and the loop among the restarts of the
        // process.
        private readonly worker: OutboxWorker = { host: os.hostname(), pid: process.pid, workerId: randomUUID() },
    ) {}

    // Called once: the source serves one generator (docs/architecture/invariants.md, "The outbox").
    public start(): void {
        this.runCompletion = this.run();
    }

    // Stops taking messages, waits for the calls in flight up to stopTimeoutMs from the call, then
    // aborts the rest and waits until they settle: the processor releases an aborted call, so
    // another node takes its message at once.
    public async stop(): Promise<void> {
        this.stopDeadlineAtMs = Date.now() + this.stopTimeoutMs;
        this.isStopping = true;
        this.wakeUpRunner?.();
        this.source.stop();

        // A pull in progress hands out its message before the loop ends, and the loop starts it:
        // left unsent, the message would wait for the recovery of its lease. Past the deadline it
        // starts aborted (startCall()).
        await this.runCompletion;

        // No call starts after the loop has ended, so one wait covers the calls both before and after
        // the abort.
        const callsSettled = Promise.all(this.callsInFlight.values());
        const haveCallsSettled = await withTimeout(callsSettled, this.stopDeadlineAtMs - Date.now());

        if (haveCallsSettled) {
            return;
        }

        for (const abortController of this.callsInFlight.keys()) {
            abortController.abort();
        }

        await callsSettled;
    }

    private async run(): Promise<void> {
        for await (const message of this.source.stream(this.worker)) {
            this.startCall(message);
            await this.waitForFreeSlotOrStop();

            if (this.isStopping) {
                return;
            }
        }
    }

    // Returns at once while a slot is free.
    private async waitForFreeSlotOrStop(): Promise<void> {
        while (!this.isStopping && this.callsInFlight.size >= this.concurrency) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.wakeUpRunner = resolve;

            await promise;
        }
    }

    // A message pulled is started at once: its lease and the limit of its chat count from the pull.
    private startCall(message: PulledOutboxMessage): void {
        const abortController = new AbortController();

        // A pull in progress at the stop handed the message out after the deadline: started aborted,
        // the call fails before grammY sends it, and the message is released without reaching
        // Telegram rather than sent and cut short on the next tick.
        if (Date.now() >= this.stopDeadlineAtMs) {
            abortController.abort();
        }
        const settled = this.processor
            .process(message, abortController.signal)
            .catch((error: unknown) => {
                this.logger.error("An outbox message was not completed, the recovery of its lease takes it back.", {
                    messageId: message.id,
                    cause: error,
                });
            })
            .finally(() => {
                this.callsInFlight.delete(abortController);
                this.wakeUpRunner?.();
            });

        this.callsInFlight.set(abortController, settled);
    }
}
