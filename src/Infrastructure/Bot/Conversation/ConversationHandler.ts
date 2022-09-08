import { Context, Conversation } from "App/Infrastructure/Bot/Types";
import { injectable } from "inversify";

@injectable()
export abstract class ConversationHandler {
    public abstract readonly name: string;
    protected ctx!: Context;
    protected conversation!: Conversation;

    public enter(ctx: Context): Promise<void> {
        return ctx.conversation.enter(this.name);
    }

    public handle(conversation: Conversation, ctx: Context): Promise<void> {
        this.ctx = ctx;
        this.conversation = conversation;

        return this.run();
    }

    protected abstract run(): Promise<void>;
}
