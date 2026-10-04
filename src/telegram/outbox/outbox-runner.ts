import os from "os";
import { randomUUID } from "crypto";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import { WorkerLoop } from "app/telegram/worker-loop/worker-loop";
import type { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import type { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import type { OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The sending of a node: the shared worker loop over the pulled messages, each slot sending one
// message at a time (docs/architecture/outbox.md, "The runner").
@injectable()
export class OutboxRunner extends WorkerLoop<PulledOutboxMessage> {
    public constructor(
        @inject<OutboxMessageSource>(Tokens.Bot.Outbox.MessageSource) protected readonly source: OutboxMessageSource,
        @inject<OutboxMessageProcessor>(Tokens.Bot.Outbox.MessageProcessor) protected readonly processor: OutboxMessageProcessor,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        protected readonly concurrency: number = configValue("outbox.concurrency"),
        protected readonly stopTimeoutMs: number = configValue("outbox.stopTimeoutMs"),
        // Goes into every attempt this loop makes: the node, and the loop among the restarts of the
        // process.
        protected readonly worker: OutboxWorker = { host: os.hostname(), pid: process.pid, workerId: randomUUID() },
    ) {
        super();
    }

    protected logUnfinished(message: PulledOutboxMessage, error: unknown): void {
        this.logger.error("An outbox message was not completed, the recovery of its lease takes it back.", {
            messageId: message.id,
            cause: error,
        });
    }
}
