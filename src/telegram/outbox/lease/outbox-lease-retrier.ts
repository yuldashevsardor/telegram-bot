import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, OutboxLease } from "app/telegram/outbox/store/outbox-store.types";

// Completes a transient failure of an attempt: the message goes back to pending after the retry
// delay, or fails and blocks its chat on the last attempt. What counts and when the limit is
// checked: docs/architecture/outbox.md, "Outcomes".
@injectable()
export class OutboxLeaseRetrier {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxRetryDelay>(Tokens.Bot.Outbox.RetryDelay) private readonly retryDelay: OutboxRetryDelay,
        private readonly maxAttempts: number = configValue("outbox.maxAttempts"),
    ) {}

    public async retryOrBlock(lease: OutboxLease & { earlierAttempts: number }, attemptError: OutboxAttemptError): Promise<void> {
        const countedAttempts = lease.earlierAttempts + 1;

        if (countedAttempts >= this.maxAttempts) {
            await this.store.markAsFailedAndBlockChat(lease, attemptError);
        } else {
            await this.store.retry(lease, attemptError, this.retryDelay.computeMs(countedAttempts));
        }
    }
}
