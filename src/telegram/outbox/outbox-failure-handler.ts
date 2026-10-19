import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { MS_PER_SECOND } from "app/shared/time";
import type { Logger } from "app/platform/logger/logger";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import type { TelegramBotApiFailure } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import type { OutboxLeaseRetrier } from "app/telegram/outbox/lease/outbox-lease-retrier";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import { isGroupChat } from "app/telegram/telegram-chat";

// A retry after a pause, a group flood's or a 401's, adds no delay of its own: the pause already
// stops the pull.
const PAUSED_RETRY_DELAY_MS = 0;

// How long every node waits after a 401 before the next message tries the token again. A revoked
// token is replaced only by a restart with a new one, and the pause is common to all the nodes: it
// is how late a node restarted with a new token starts sending, and how often the old token is
// tried meanwhile: the probes after each pause (docs/architecture/outbox.md, "Outcomes").
export const UNAUTHORIZED_PAUSE_SECONDS = 60;

// The outcome of a failed send, by the class of its error (docs/architecture/outbox.md, "Failures").
@injectable()
export class OutboxFailureHandler {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly classifier: TelegramBotApiFailureClassifier,
        @inject<OutboxLeaseRetrier>(Tokens.Bot.Outbox.Lease.Retrier) private readonly leaseRetrier: OutboxLeaseRetrier,
        @inject<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer) private readonly errorSerializer: OutboxErrorSerializer,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
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
                return this.leaseRetrier.retryOrBlock(message, attemptError);
            case TelegramBotApiFailureKind.Flood:
                return isGroupChat(message.chatId)
                    ? this.pauseForFlood(message, failure.retryAfterSeconds, attemptError)
                    : this.holdBackChatForFlood(message, failure.retryAfterSeconds, attemptError);
            case TelegramBotApiFailureKind.Undeliverable:
                return this.failUndeliverable(message, attemptError);
            case TelegramBotApiFailureKind.TooLarge:
                return this.failTooLarge(message, attemptError);
            case TelegramBotApiFailureKind.Unauthorized:
                return this.pauseForUnauthorized(message, attemptError);
            case TelegramBotApiFailureKind.Unexpected:
                return this.store.markAsFailedAndBlockChat(message, attemptError);
        }
    }

    // The pause goes first: back in pending before it, the message could be pulled again into the
    // same 429 or 401.
    private async pauseAndRetry(message: PulledOutboxMessage, pauseSeconds: number, attemptError: OutboxAttemptError): Promise<void> {
        await this.store.pause(pauseSeconds * MS_PER_SECOND);
        await this.store.retry(message, attemptError, PAUSED_RETRY_DELAY_MS);
    }

    // The warning goes before the pause, so a retry_after that pause() refuses is logged too. Why a
    // 429 is logged at all is in docs/architecture/outbox.md, "Outcomes".
    private async pauseForFlood(message: PulledOutboxMessage, retryAfterSeconds: number, attemptError: OutboxAttemptError): Promise<void> {
        this.logger.warning("The Bot API answers 429: pausing the outbox.", {
            messageId: message.id,
            chatId: message.chatId,
            retryAfterSeconds: retryAfterSeconds,
            cause: attemptError,
        });

        await this.pauseAndRetry(message, retryAfterSeconds, attemptError);
    }

    // A 429 of a private chat holds back that chat alone: Telegram counts the messages of a private
    // chat in a window of its own, and the other chats go on sending (docs/architecture/outbox.md,
    // "Outcomes").
    private async holdBackChatForFlood(
        message: PulledOutboxMessage,
        retryAfterSeconds: number,
        attemptError: OutboxAttemptError,
    ): Promise<void> {
        this.logger.warning("The Bot API answers 429: holding back the chat.", {
            messageId: message.id,
            chatId: message.chatId,
            retryAfterSeconds: retryAfterSeconds,
            cause: attemptError,
        });

        await this.store.retry(message, attemptError, retryAfterSeconds * MS_PER_SECOND);
    }

    // Whether the completion was fenced does not matter: nothing follows it.
    private async failUndeliverable(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        await this.store.markAsFailed(message, attemptError);
    }

    // A 413 means the upload limit of the configuration no longer matches Telegram's, or a call
    // uploads files without checking it (docs/architecture/outbox.md, "Error classes"). No chat is
    // blocked, so the handler logs it as an error itself. A fenced completion failed nothing: the
    // completion that came first has an outcome of its own, and a send it leads to logs its own 413.
    private async failTooLarge(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        const hasFailed = await this.store.markAsFailed(message, attemptError);

        if (!hasFailed) {
            return;
        }

        this.logger.error("The Bot API refuses a request over its upload limit: the message is failed.", {
            messageId: message.id,
            chatId: message.chatId,
            method: message.method,
            cause: attemptError,
        });
    }

    // Nothing else shows a revoked token: no chat is blocked, the sending only stops.
    private async pauseForUnauthorized(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        this.logger.error("The Bot API refuses the bot token: the outbox is paused.", {
            messageId: message.id,
            pauseSeconds: UNAUTHORIZED_PAUSE_SECONDS,
            cause: attemptError,
        });

        await this.pauseAndRetry(message, UNAUTHORIZED_PAUSE_SECONDS, attemptError);
    }
}
