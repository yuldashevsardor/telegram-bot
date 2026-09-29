import { inject, injectable } from "inversify";
import { serializeError } from "serialize-error";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import type { TelegramBotApiFailure } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { RetryDelay } from "app/telegram/outbox/retry-delay/retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The outcome of a failed send, by the class of its error (docs/architecture/outbox.md, "Failures").
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
        // The whole error, not only its message: the stack, and the fields of the answer that grammY
        // keeps on its errors (error_code, description, parameters, method, payload). serializeError
        // wraps a value that is not an Error into NonError. The kind is written over a field of the
        // same name; the serialized object is a fresh one.
        const attemptError: OutboxAttemptError = Object.assign(serializeError(error), { kind: failure.kind });

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
            case TelegramBotApiFailureKind.Unexpected:
                return this.store.markAsFailedAndBlockChat(message, attemptError);
        }
    }

    // The pause goes first: back in pending before it, the message could be pulled again into the
    // same 429. The retry adds no delay of its own.
    private async pauseAndRetry(message: PulledOutboxMessage, retryAfterSeconds: number, attemptError: OutboxAttemptError): Promise<void> {
        await this.store.pause(retryAfterSeconds * MS_PER_SECOND);
        await this.store.retry(message, attemptError, 0);
    }

    private async retryOrBlock(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        // This attempt counts too.
        const countedAttempts = this.countFailures(message) + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.store.markAsFailedAndBlockChat(message, attemptError);
        } else {
            await this.store.retry(message, attemptError, this.retryDelay.computeMs(countedAttempts));
        }
    }

    // The earlier attempts that failed and count towards the limit: a flood does not count. The last
    // attempt is the open one of this send, with no error yet.
    private countFailures(message: PulledOutboxMessage): number {
        let failures = 0;

        for (const attempt of message.attempts) {
            if (attempt.error !== null && attempt.error.kind !== TelegramBotApiFailureKind.Flood) {
                failures += 1;
            }
        }

        return failures;
    }
}
