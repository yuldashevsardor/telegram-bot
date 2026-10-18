import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

@injectable()
export class HelpCommand extends Command {
    public readonly command: string = "help";

    public readonly descriptionKey: string = "help-command-description";

    public constructor(
        @inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats,
        private readonly authorContact: string = configValue("bot.authorContact"),
    ) {
        super();
    }

    // Public: an unknown command gets the same answer (UnknownCommandMiddleware).
    public async handle(ctx: Context): Promise<void> {
        await ctx.reply(ctx.t("help-command-text", { formats: this.supportedFormats.toText(), contact: this.authorContact }));
    }
}
