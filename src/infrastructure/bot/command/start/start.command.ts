import { Command } from "app/infrastructure/bot/command/command";
import { inject, injectable } from "inversify";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Context } from "app/infrastructure/bot/bot.types";
import { StartConversation } from "app/infrastructure/bot/conversation/start/start.conversation";

@injectable()
export class StartCommand extends Command {
    public readonly command: string = "start";

    public readonly description: string = "Главное меню / Main menu";

    public constructor(@inject<StartConversation>(Modules.Bot.Conversations.Start) private readonly startConversation: StartConversation) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        return this.startConversation.enter(ctx);
    }
}
