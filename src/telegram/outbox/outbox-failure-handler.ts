import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { RetryDelay } from "app/telegram/outbox/retry-delay/retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The outcome of a failed send, by the class of its error (docs/architecture/outbox.md, "Outcomes").
@injectable()
export class OutboxFailureHandler {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly classifier: TelegramBotApiFailureClassifier,
        @inject<RetryDelay>(Tokens.Bot.Outbox.RetryDelay) private readonly retryDelay: RetryDelay,
        private readonly maxAttempts: number = configValue("outbox.maxAttempts"),
    ) {}

    public async handle(message: PulledOutboxMessage, error: unknown): Promise<void> {
        const failure = this.classifier.classify(error);
        const attemptError: OutboxAttemptError = {
            kind: failure.kind,
            message: error instanceof Error ? error.message : String(error),
        };

        switch (failure.kind) {
            case TelegramBotApiFailureKind.Transient:
                await this.retryOrBlock(message, attemptError);
                return;
            case TelegramBotApiFailureKind.Flood:
                // The pause goes first: back in pending before it, the message could be pulled again
                // into the same 429.
                await this.store.pause(failure.retryAfterSeconds * MS_PER_SECOND);
                await this.store.retry(message, attemptError, 0);
                return;
            case TelegramBotApiFailureKind.Undeliverable:
                await this.store.markAsFailed(message, attemptError);
                return;
            case TelegramBotApiFailureKind.Unexpected:
                await this.store.markAsFailedAndBlockChat(message, attemptError);
                return;
        }
    }

    private async retryOrBlock(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        const countedAttempts = message.countedFailures + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.store.markAsFailedAndBlockChat(message, attemptError);
            return;
        }

        await this.store.retry(message, attemptError, this.retryDelay.computeMs(countedAttempts));
    }
}
