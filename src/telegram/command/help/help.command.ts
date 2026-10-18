import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Context } from "app/telegram/bot/bot.types";
import type { HelpText } from "app/telegram/command/help/help-text";

@injectable()
export class HelpCommand extends Command {
    public readonly command: string = "help";

    public readonly descriptionKey: string = "help-command-description";

    public constructor(@inject<HelpText>(Tokens.Bot.HelpText) private readonly helpText: HelpText) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        await ctx.reply(this.helpText.build(ctx));
    }
}
