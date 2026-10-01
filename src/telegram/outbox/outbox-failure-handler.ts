import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type { Logger } from "app/platform/logger/logger";
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

// The error of the attempt a release on stop closes: the call may have reached Telegram or not.
const NODE_STOPPED: OutboxAttemptError = {
    name: "OutboxNodeStopped",
    message: "The node stopped before the call of the message finished: the message is released to any node.",
    kind: TelegramBotApiFailureKind.Transient,
};

// A released message waits for no retry delay: the stop says nothing about the message.
const RELEASE_DELAY_MS = 0;

// A retry after a pause, a flood's or a 401's, adds no delay of its own: the pause already stops
// the pull.
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
        @inject<OutboxRetryDelay>(Tokens.Bot.Outbox.RetryDelay) private readonly retryDelay: OutboxRetryDelay,
        @inject<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer) private readonly errorSerializer: OutboxErrorSerializer,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
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

    // A message whose call the stopping node did not finish goes back to pending, and its chat is
    // ready for the next pull on any node. The attempt counts as a transient failure's, although the
    // limit of attempts is not checked: the stop says nothing about the message, so it blocks no chat.
    // The call must have settled before: a call still on its way could reach Telegram after the
    // next message of the chat (docs/architecture/outbox.md, "Release on stop").
    public async releaseOnStop(lease: OutboxLease): Promise<void> {
        // The node that would pull the message next is this one, and it stops: an idle node sleeps
        // until a notification otherwise.
        await this.store.retry(lease, NODE_STOPPED, RELEASE_DELAY_MS, { wakeIdleNodes: true });
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

    // Nothing else shows a revoked token: no chat is blocked, the sending only stops.
    private async pauseForUnauthorized(message: PulledOutboxMessage, attemptError: OutboxAttemptError): Promise<void> {
        this.logger.error("The Bot API refuses the bot token: the outbox is paused.", {
            messageId: message.id,
            pauseSeconds: UNAUTHORIZED_PAUSE_SECONDS,
            cause: attemptError,
        });

        await this.pauseAndRetry(message, UNAUTHORIZED_PAUSE_SECONDS, attemptError);
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
