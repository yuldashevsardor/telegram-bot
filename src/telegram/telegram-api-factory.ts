import { Api } from "grammy";
import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";

// An Api of its own for the outbox, which sends with it, and for the polling source of the inbox,
// which polls with it: not the one of the bot.
@injectable()
export class TelegramApiFactory {
    public constructor(private readonly botToken: string = configValue("bot.token")) {}

    // No transformers: a transformer that routes the calls of the bot into the outbox would route
    // the call of the outbox back into it, and getUpdates has nothing to do with the outbox. The
    // timeout is explicit because grammY waits 500 s by default: a call of the outbox must end within
    // the lease of its chat (docs/architecture/invariants.md, "The outbox"), and a poll stuck on a dead
    // connection would hold the polling that long.
    public create(timeoutSeconds: number): Api {
        return new Api(this.botToken, { timeoutSeconds: timeoutSeconds });
    }
}
