import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

@injectable()
export class StartCommand extends Command {
    public readonly command: string = "start";

    public readonly descriptionKey: string = "start-command-description";

    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {
        super();
    }

    // A plain reply: the bot waits for no particular answer, so a repeated /start gives the same text.
    protected async handle(ctx: Context): Promise<void> {
        await ctx.reply(ctx.t("start-command-welcome", { formats: this.supportedFormats.toText() }));
    }
}
