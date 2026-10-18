import { Context } from "grammy";
import type { Update } from "grammy/types";
import type { Fluent } from "@moebius/fluent";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { OutboxPriority } from "app/telegram/outbox/store/outbox-store.types";

const ANSWER_METHOD = "sendMessage";

// The answer to the sender of an update whose handling failed for good (docs/product/cjm.md,
// "5. Errors", the last row). It goes from outside the pipeline, so it is pushed into the outbox
// without the wait of a call of the bot: nobody awaits its outcome.
@injectable()
export class FailedUpdateAnswer {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Fluent>(Tokens.Bot.Fluent) private readonly fluent: Fluent,
        private readonly authorContact: string = configValue("bot.authorContact"),
    ) {}

    public async send(chatId: number, update: Update): Promise<void> {
        const text = this.fluent.withLocale(this.senderLanguageCode(update))("failed-update-answer-text", { contact: this.authorContact });

        await this.store.push({
            chatId: chatId,
            method: ANSWER_METHOD,
            payload: serialize(ANSWER_METHOD, { chat_id: chatId, text: text }),
            priority: OutboxPriority.Call,
        });
    }

    // The locale the pipeline would have answered in: ctx.from of grammY, by the rule of
    // createFluentMiddleware(). A Context reads from out of the update alone and never calls the Api
    // or the bot it is given, so it gets neither.
    private senderLanguageCode(update: Update): string {
        const sender = new Context(update, undefined as never, undefined as never).from;

        return sender?.language_code ?? DEFAULT_LOCALE;
    }
}
