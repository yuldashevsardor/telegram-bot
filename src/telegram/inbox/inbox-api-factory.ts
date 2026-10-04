import { Api } from "grammy";
import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";

// The Api the polling source of the inbox calls Telegram with: its own, not the one of the bot.
@injectable()
export class InboxApiFactory {
    public constructor(private readonly botToken: string = configValue("bot.token")) {}

    // No transformers: getUpdates has nothing to do with the outbox the transformer of the bot routes
    // the calls into. The timeout is explicit because grammY waits 500 s by default, and a call stuck
    // on a dead connection would hold the polling that long.
    public create(timeoutSeconds: number): Api {
        return new Api(this.botToken, { timeoutSeconds: timeoutSeconds });
    }
}
