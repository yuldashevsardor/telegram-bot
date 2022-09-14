import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";
import { injectable } from "inversify";

@injectable()
export class StartConversation extends ConversationHandler {
    public readonly name: string = "start";

    public async run(): Promise<void> {
        await this.ctx.reply(`Добро пожаловать ${this.ctx.from?.username}. Напиши что нибудь и я повторю за тобой...`);
        const nextMessage = await this.conversation.wait();

        await nextMessage.reply(nextMessage.message?.text || "Чет не получилось...");
    }
}
