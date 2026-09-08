import { Context, Conversation } from "app/infrastructure/bot/bot.types";
import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { inject, injectable } from "inversify";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { Services } from "app/infrastructure/container/symbols/services";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public constructor(
        @inject<ConvertorFactory>(Services.FontConvertor.ConvertorFactory) private readonly convertorFactory: ConvertorFactory,
    ) {
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
