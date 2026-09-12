import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { Tokens } from "app/common/tokens";
import { Context } from "app/telegram/bot.types";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";

@injectable()
export class StartCommand extends Command {
    public readonly command: string = "start";

    public readonly descriptionKey: string = "start-command-description";

    public constructor(@inject<StartConversation>(Tokens.Bot.Conversations.Start) private readonly startConversation: StartConversation) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        return this.startConversation.enter(ctx);
    }
}
