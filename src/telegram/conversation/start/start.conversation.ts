import type { Context, Conversation } from "app/telegram/bot/bot.types";
import { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { inject, injectable } from "inversify";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Tokens } from "app/shared/tokens";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public constructor(@inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory) {
        super();
    }

    protected async run(conversation: Conversation, ctx: Context): Promise<void> {
        // The list comes from the pair matrix instead of being spelled out here as a string:
        // otherwise what is promised to the user drifts from what the domain can actually do.
        const text = ctx.t("start-conversation-welcome", {
            formats: this.convertorFactory.getSupportedExtensions().join(", "),
        });
        await ctx.reply(text);
        const nextMessage = await conversation.wait();

        await nextMessage.reply(nextMessage.message?.text || nextMessage.t("start-conversation-not-text"));
    }
}
