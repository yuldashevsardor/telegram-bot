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
// (docs/architecture/outbox.md, "The worker loop"). The loop writes no outcome: the processor does.
@injectable()
export class OutboxWorkerLoop {
    // A call in flight by the controller that aborts it; the promise settles once the processor has
    // written its outcome or released it, and never rejects.
    private readonly callsInFlight = new Map<AbortController, Promise<void>>();
    // Ends the latest wait of a loop with every slot busy: a call that settles or the stop calls it,
    // and a call after the wait has ended changes nothing. One resolver per wait: a race with a
    // promise pending until the stop would leave a reaction on it per wait, and the heap would grow
    // with every message sent.
    private wakeUpLoop: (() => void) | undefined;
    private isStopping = false;
    // When stop() aborts the calls in flight; none before the stop.
    private stopDeadlineAt = Number.POSITIVE_INFINITY;
    private loopRun: Promise<void> = Promise.resolve();

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
        this.loopRun = this.run();
    }

    // Stops taking messages, waits for the calls in flight up to stopTimeoutMs from the call, then
    // aborts the rest and waits until they settle: the processor releases an aborted call, so
    // another node takes its message at once.
    public async stop(): Promise<void> {
        this.stopDeadlineAt = Date.now() + this.stopTimeoutMs;
        this.isStopping = true;
        this.wakeUpLoop?.();
        this.source.stop();

        // A pull in progress hands out its message before the loop ends, and the loop starts it:
        // left unsent, the message would wait for the recovery of its lease. Past the deadline it
        // starts aborted (startCall()).
        await this.loopRun;

        const haveCallsSettled = await withTimeout(Promise.all(this.callsInFlight.values()), this.stopDeadlineAt - Date.now());

        if (haveCallsSettled) {
            return;
        }

        for (const abortController of this.callsInFlight.keys()) {
            abortController.abort();
        }

        await Promise.all(this.callsInFlight.values());
    }

    private async run(): Promise<void> {
        const messages = this.source.stream(this.worker);

        while (!this.isStopping) {
            if (this.callsInFlight.size >= this.concurrency) {
                await this.waitForFreeSlotOrStop();
                continue;
            }

            const nextMessageResult = await messages.next();

            if (nextMessageResult.done === true) {
                return;
            }

            this.startCall(nextMessageResult.value);
        }
    }

    private async waitForFreeSlotOrStop(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.wakeUpLoop = resolve;

        await promise;
    }

    // A message pulled is started at once: its lease and the limit of its chat count from the pull.
    private startCall(message: PulledOutboxMessage): void {
        const abortController = new AbortController();

        // A pull in progress at the stop handed the message out after the deadline: started aborted,
        // the call fails before grammY sends it, and the message is released without reaching
        // Telegram rather than sent and cut short on the next tick.
        if (Date.now() >= this.stopDeadlineAt) {
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
                this.wakeUpLoop?.();
            });

        this.callsInFlight.set(abortController, settled);
    }
}
