import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";

// Takes back the messages of the expired leases (docs/architecture/outbox.md, "Lease recovery").
@injectable()
export class OutboxLeaseRecovery {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxFailureHandler>(Tokens.Bot.Outbox.FailureHandler) private readonly failureHandler: OutboxFailureHandler,
    ) {}

    // The leases are completed one after another, and a completion that throws ends the call: the
    // leases after it wait for the next one.
    public async recover(): Promise<void> {
        const expiredLeases = await this.store.findExpiredLeases();

        for (const expiredLease of expiredLeases) {
            await this.failureHandler.handleExpiredLease(expiredLease);
        }
    }
}
