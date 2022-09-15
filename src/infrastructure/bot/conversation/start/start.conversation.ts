import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { injectable } from "inversify";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public async run(): Promise<void> {
        const text = this.ctx.t("welcome", {
            formats: "woff, woff2, otf, ttf",
        });
        await this.ctx.reply(text);
        const nextMessage = await this.conversation.wait();

        await nextMessage.reply(nextMessage.message?.text || "Чет не получилось...");
    }
}
