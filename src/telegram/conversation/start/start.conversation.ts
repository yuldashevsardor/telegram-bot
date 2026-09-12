import { Context, Conversation } from "app/telegram/bot.types";
import { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { inject, injectable } from "inversify";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Tokens } from "app/shared/tokens";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public constructor(@inject<ConvertorFactory>(Tokens.Font.Convertor.Factory) private readonly convertorFactory: ConvertorFactory) {
        super();
    }

    protected async run(conversation: Conversation, ctx: Context): Promise<void> {
        // Список берётся из матрицы пар, а не пишется здесь строкой: иначе обещание
        // пользователю расходится с тем, что домен на самом деле умеет.
        const text = ctx.t("start-conversation-welcome", {
            formats: this.convertorFactory.getSupportedExtensions().join(", "),
        });
        await ctx.reply(text);
        const nextMessage = await conversation.wait();

        await nextMessage.reply(nextMessage.message?.text || nextMessage.t("start-conversation-not-text"));
    }
}
