import { Api } from "grammy";
import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";

// The Api the outbox sends with: its own, not the one of the bot.
@injectable()
export class OutboxApiFactory {
    public constructor(
        private readonly botToken: string = configValue("bot.token"),
        private readonly apiTimeoutMs: number = configValue("outbox.apiTimeoutMs"),
    ) {}

    // No transformers: a transformer that routes the calls of the bot into the outbox would route
    // the call of the outbox back into it. The timeout is explicit because grammY waits 500 s by
    // default, and a call must end within the lease of its chat (docs/architecture/invariants.md,
    // "The outbox").
    public create(): Api {
        return new Api(this.botToken, { timeoutSeconds: this.apiTimeoutMs / MS_PER_SECOND });
    }
}
