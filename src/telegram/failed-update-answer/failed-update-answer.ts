import { Context as GrammyContext } from "grammy";
import type { Update } from "@grammyjs/types";
import type { Fluent } from "@moebius/fluent";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Context } from "app/telegram/bot/bot.types";
import { createFluentMiddleware } from "app/telegram/locale/locale";
import { isGroupChat } from "app/telegram/telegram-chat";
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
        // The journey covers private chats only, and the bot says nothing in a group. A group update
        // reaches the inbox and can fail before IsPrivateChatFilter drops it: in init() of the bot, or
        // on the node that dies with its lease.
        if (isGroupChat(chatId)) {
            return;
        }

        const text = await this.translateForSender(update);

        await this.store.push({
            chatId: chatId,
            method: ANSWER_METHOD,
            payload: serialize(ANSWER_METHOD, { chat_id: chatId, text: text }),
            priority: OutboxPriority.Call,
        });
    }

    // In the locale the pipeline would have answered in: the Fluent middleware of the pipeline itself
    // fills ctx.t of a Context of the update, so the rule of the locale stays in
    // createFluentMiddleware() alone. The middleware reads ctx.from, which reads the update alone and
    // never touches the Api or the bot of the Context, so it gets neither; the casts hide that from
    // the type checker, and the spec of this class holds it for a message and a button press instead.
    private async translateForSender(update: Update): Promise<string> {
        const ctx = new GrammyContext(update, undefined as never, undefined as never) as Context;

        await createFluentMiddleware(this.fluent)(ctx, async () => undefined);

        return ctx.t("failed-update-answer-text", { contact: this.authorContact });
    }
}
