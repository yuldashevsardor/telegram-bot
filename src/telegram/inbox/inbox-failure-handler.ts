import { BotError } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { InboxFailureClassifier } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxAttemptError, InboxLease } from "app/telegram/inbox/store/inbox-store.types";
import type { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import type { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import type { FailedUpdateAnswer } from "app/telegram/failed-update-answer/failed-update-answer";

// The error of the attempt an expired lease closes: the node that claimed the update reported nothing.
const LEASE_EXPIRED: InboxAttemptError = {
    name: "InboxLeaseExpired",
    message: "The lease of the group passed before its update was completed: the node that claimed it is presumed dead.",
    kind: InboxFailureKind.Transient,
};

// The outcome of an update whose handler failed, by the class of its error
// (docs/architecture/inbox.md, "Failures").
@injectable()
export class InboxFailureHandler {
    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<InboxFailureClassifier>(Tokens.Bot.Inbox.FailureClassifier) private readonly classifier: InboxFailureClassifier,
        @inject<RetryDelay>(Tokens.Bot.RetryDelay) private readonly retryDelay: RetryDelay,
        @inject<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer) private readonly errorSerializer: OutboxErrorSerializer,
        @inject<FailedUpdateAnswer>(Tokens.Bot.FailedUpdateAnswer) private readonly failedUpdateAnswer: FailedUpdateAnswer,
        private readonly maxAttempts: number = configValue("inbox.maxAttempts"),
    ) {}

    // error is what the handling threw. Bot.handleUpdate() wraps an error of the middleware into a
    // BotError, whose ctx holds the whole context, the Api with its token included: the class and the
    // attempt take the handler's own error out of it.
    public async handle(update: ClaimedInboxUpdate, error: unknown): Promise<void> {
        const handlerError = error instanceof BotError ? error.error : error;
        const kind = this.classifier.classify(handlerError);
        // The kind goes last, over a field of the same name.
        const attemptError: InboxAttemptError = { ...this.errorSerializer.serialize(handlerError), kind: kind };

        await this.applyOutcome(update, kind, attemptError);
    }

    // The update of every expired lease is a transient failure: whether the node died before the
    // handler ran or after it replied cannot be told, so it is handled again
    // (docs/architecture/inbox.md, "Lease recovery").
    public async recoverExpiredLeases(): Promise<void> {
        const expiredLeases = await this.store.findExpiredLeases();

        for (const expiredLease of expiredLeases) {
            await this.retryOrBlock(expiredLease, LEASE_EXPIRED);
        }
    }

    // Not async on purpose: a switch that misses a kind leaves the end of the function reachable,
    // and a function returning a Promise without undefined in it does not compile then.
    private applyOutcome(update: ClaimedInboxUpdate, kind: InboxFailureKind, attemptError: InboxAttemptError): Promise<void> {
        switch (kind) {
            case InboxFailureKind.Transient:
                return this.retryOrBlock(update, attemptError);
            case InboxFailureKind.Undeliverable:
            case InboxFailureKind.ReplyTimeout:
                return this.store.markAsFailed(update, attemptError);
            case InboxFailureKind.Unexpected:
                return this.failAndBlockGroup(update, attemptError);
        }
    }

    // Every attempt counts, the one being handled included, and the limit is checked on a transient
    // failure only (docs/architecture/inbox.md, "Outcomes").
    private async retryOrBlock(lease: InboxLease & { earlierAttempts: number }, attemptError: InboxAttemptError): Promise<void> {
        const countedAttempts = lease.earlierAttempts + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.failAndBlockGroup(lease, attemptError);
        } else {
            await this.store.retry(lease, attemptError, this.retryDelay.computeMs(countedAttempts));
        }
    }

    // The sender of an update that blocks its group is answered, once (docs/architecture/inbox.md,
    // "The answer to the sender"). A failure that does not block is not: an undeliverable chat takes
    // no message, and the reply a timeout left in the outbox may still go out. A fenced completion
    // failed nothing: the completion that came first has an outcome of its own.
    private async failAndBlockGroup(lease: InboxLease, attemptError: InboxAttemptError): Promise<void> {
        const failedUpdate = await this.store.markAsFailedAndBlockGroup(lease, attemptError);

        if (failedUpdate === null) {
            return;
        }

        await this.failedUpdateAnswer.send(failedUpdate.chatId, failedUpdate.update);
    }
}
