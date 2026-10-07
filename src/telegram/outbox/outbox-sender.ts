import type { Api, RawApi } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import type { OutboxJson } from "app/telegram/outbox/store/outbox-store.types";

// A Bot API method as the outbox calls it: by a name read from the row, with the payload and the
// signal that aborts the call.
type OutboxApiMethod = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<OutboxJson>;

// Makes the Bot API call of an outbox message; what its outcome does to the message is
// OutboxMessageProcessor's (docs/architecture/outbox.md, "Sending").
@injectable()
export class OutboxSender {
    private readonly api: Api;

    public constructor(
        @inject<TelegramApiFactory>(Tokens.Bot.ApiFactory) apiFactory: TelegramApiFactory,
        apiTimeoutMs: number = configValue("outbox.apiTimeoutMs"),
    ) {
        this.api = apiFactory.create(apiTimeoutMs / MS_PER_SECOND);
    }

    // Resolves with Telegram's result and throws the error of the call as grammY throws it; an abort
    // through signal throws an HttpError too, as grammY wraps every failed fetch. The method comes
    // from the row, so the compiler cannot check its name against RawApi: an unknown one reaches
    // Telegram and fails there. grammY binds an empty payload to its methods without parameters
    // (getMe, logOut and the like; createRawApi() in its core/client.js), so the payload passed here
    // would stand for the signal and fail the call. None of them is sent to a chat, and every outbox
    // message is.
    public send(method: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<OutboxJson> {
        const apiMethod = this.api.raw[method as keyof RawApi] as unknown as OutboxApiMethod;

        return apiMethod(payload, signal);
    }
}
