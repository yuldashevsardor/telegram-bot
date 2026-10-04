import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { OutboxRetrier } from "app/telegram/outbox/outbox-retrier";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError } from "app/telegram/outbox/store/outbox-store.types";

// The error of the attempt an expired lease closes: the node that made it reported nothing.
const LEASE_EXPIRED: OutboxAttemptError = {
    name: "OutboxLeaseExpired",
    message: "The lease of the chat passed before its message was completed: the node that pulled it is presumed dead.",
    kind: TelegramBotApiFailureKind.Transient,
};

// Takes back the messages of the expired leases (docs/architecture/outbox.md, "Lease recovery").
@injectable()
export class OutboxLeaseRecovery {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxRetrier>(Tokens.Bot.Outbox.Retrier) private readonly retrier: OutboxRetrier,
    ) {}

    // The message of every expired lease is a transient failure: whether the node died before the
    // call or after Telegram took it cannot be told, so it goes out again. The leases are completed
    // one after another, and a completion that throws ends the call: the leases after it wait for
    // the next one.
    public async recover(): Promise<void> {
        const expiredLeases = await this.store.findExpiredLeases();

        for (const expiredLease of expiredLeases) {
            await this.retrier.retryOrBlock(expiredLease, LEASE_EXPIRED);
        }
    }
}
