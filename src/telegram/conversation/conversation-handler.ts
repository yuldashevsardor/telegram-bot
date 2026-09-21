import type { Context, Conversation } from "app/telegram/bot/bot.types";
import { injectable } from "inversify";

@injectable()
export abstract class ConversationHandler {
    public abstract readonly name: string;

    public enter(ctx: Context): Promise<void> {
        return ctx.conversation.enter(this.name);
    }

    // One instance for the whole process, while conversations of different users run
    // concurrently: ctx and conversation travel as parameters so that another conversation has
    // nowhere to overwrite them.
    public handle(conversation: Conversation, ctx: Context): Promise<void> {
        return this.run(conversation, ctx);
    }

    protected abstract run(conversation: Conversation, ctx: Context): Promise<void>;
}
