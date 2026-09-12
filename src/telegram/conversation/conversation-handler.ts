import { Context, Conversation } from "app/telegram/bot.types";
import { injectable } from "inversify";

@injectable()
export abstract class ConversationHandler {
    public abstract readonly name: string;

    public enter(ctx: Context): Promise<void> {
        return ctx.conversation.enter(this.name);
    }

    // Экземпляр один на весь процесс, а разговоры разных пользователей идут конкурентно:
    // ctx и conversation ходят параметрами, чтобы их негде было перетереть чужому разговору.
    public handle(conversation: Conversation, ctx: Context): Promise<void> {
        return this.run(conversation, ctx);
    }

    protected abstract run(conversation: Conversation, ctx: Context): Promise<void>;
}
