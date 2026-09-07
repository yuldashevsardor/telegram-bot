import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { injectable } from "inversify";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public async run(): Promise<void> {
        const text = this.ctx.t("start-conversation-welcome", {
            formats: "woff, woff2, otf, ttf",
        });
        await this.ctx.reply(text);
        const nextMessage = await this.conversation.wait();

        // Переводим через this.ctx: контексты, которые отдаёт conversation.wait(), собраны
        // плагином разговоров заново и внешние middleware, включая useFluent, на них не
        // выполнялись — у nextMessage нет t().
        await nextMessage.reply(nextMessage.message?.text || this.ctx.t("start-conversation-not-text"));
    }
}
