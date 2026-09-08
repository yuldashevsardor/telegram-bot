import { Context, Conversation } from "app/infrastructure/bot/bot.types";
import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { injectable } from "inversify";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    protected async run(conversation: Conversation, ctx: Context): Promise<void> {
        const text = ctx.t("start-conversation-welcome", {
            formats: "woff, woff2, otf, ttf",
        });
        await ctx.reply(text);
        const nextMessage = await conversation.wait();

        await nextMessage.reply(nextMessage.message?.text || nextMessage.t("start-conversation-not-text"));
    }
}
