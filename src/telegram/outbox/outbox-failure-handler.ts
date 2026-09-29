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
import type { OutboxAttemptError, OutboxLease, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The error of the attempt an expired lease closes: the node that made it reported nothing.
const LEASE_EXPIRED: OutboxAttemptError = {
    name: "OutboxLeaseExpired",
    message: "The lease of the chat passed before its message was completed: the node that pulled it is presumed dead.",
    kind: TelegramBotApiFailureKind.Transient,
};

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

    // The message of every expired lease is a transient failure: whether the node died before the
    // call or after Telegram took it cannot be told, so it goes out again (docs/architecture/outbox.md,
    // "Lease recovery").
    public async recoverExpiredLeases(): Promise<void> {
        const expiredLeases = await this.store.findExpiredLeases();

        for (const expiredLease of expiredLeases) {
            await this.retryOrBlock(expiredLease, LEASE_EXPIRED);
        }
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

    // What counts and when the limit is checked: docs/architecture/outbox.md, "Outcomes".
    private async retryOrBlock(lease: OutboxLease & { earlierAttempts: number }, attemptError: OutboxAttemptError): Promise<void> {
        const countedAttempts = lease.earlierAttempts + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.store.markAsFailedAndBlockChat(lease, attemptError);
        } else {
            await this.store.retry(lease, attemptError, this.retryDelay.computeMs(countedAttempts));
        }
    }
}
