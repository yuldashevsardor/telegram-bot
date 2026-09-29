import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import type { TelegramBotApiFailure } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import type { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// How long every node waits after a 401 before the next message tries the token again. A revoked
// token is replaced only by a restart with a new one, and the pause is common to all the nodes: it
// is how late a node restarted with a new token starts sending, and how often the old token is
// tried meanwhile, one attempt of one message per pause.
export const UNAUTHORIZED_PAUSE_SECONDS = 60;

// The outcome of a failed send, by the class of its error (docs/architecture/outbox.md, "Failures").
@injectable()
export class OutboxFailureHandler {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly classifier: TelegramBotApiFailureClassifier,
        @inject<OutboxRetryDelay>(Tokens.Bot.Outbox.RetryDelay) private readonly retryDelay: OutboxRetryDelay,
        @inject<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer) private readonly errorSerializer: OutboxErrorSerializer,
        private readonly maxAttempts: number = configValue("outbox.maxAttempts"),
    ) {}

    public async handle(message: PulledOutboxMessage, error: unknown): Promise<void> {
        const failure = this.classifier.classify(error);
        // The kind goes last, over a field of the same name.
        const attemptError: OutboxAttemptError = { ...this.errorSerializer.serialize(error), kind: failure.kind };

        await this.applyOutcome(message, failure, attemptError);
    }

    // Not async on purpose: a switch that misses a kind leaves the end of the function reachable,
    // and a function returning a Promise without undefined in it does not compile then.
    private applyOutcome(message: PulledOutboxMessage, failure: TelegramBotApiFailure, attemptError: OutboxAttemptError): Promise<void> {
        switch (failure.kind) {
            case TelegramBotApiFailureKind.Transient:
                return this.retryOrBlock(message, attemptError);
            case TelegramBotApiFailureKind.Flood:
                return this.pauseAndRetry(message, failure.retryAfterSeconds, attemptError);
            case TelegramBotApiFailureKind.Undeliverable:
                return this.store.markAsFailed(message, attemptError);
            case TelegramBotApiFailureKind.Unauthorized:
                return this.pauseAndRetry(message, UNAUTHORIZED_PAUSE_SECONDS, attemptError);
            case TelegramBotApiFailureKind.Unexpected:
                return this.store.markAsFailedAndBlockChat(message, attemptError);
        }
    }

    // The pause goes first: back in pending before it, the message could be pulled again into the
    // same 429 or 401. The retry adds no delay of its own.
    private async pauseAndRetry(message: PulledOutboxMessage, pauseSeconds: number, attemptError: OutboxAttemptError): Promise<void> {
        await this.store.pause(pauseSeconds * MS_PER_SECOND);
        await this.store.retry(message, attemptError, 0);
    }

    // What counts and when the limit is checked: docs/architecture/outbox.md, "Outcomes".
    private async retryOrBlock(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        const countedAttempts = message.earlierAttempts + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.store.markAsFailedAndBlockChat(message, attemptError);
        } else {
            await this.store.retry(message, attemptError, this.retryDelay.computeMs(countedAttempts));
        }
    }
}
