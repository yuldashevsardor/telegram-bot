import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

// The text of /help, which an unknown command gets too (UnknownCommandMiddleware).
@injectable()
export class HelpText {
    public constructor(
        @inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats,
        private readonly authorContact: string = configValue("bot.authorContact"),
        private readonly maxDownloadSizeMb: number = configValue("bot.maxDownloadSizeMb"),
    ) {}

    public build(ctx: Context): string {
        return ctx.t("help-command-text", {
            formats: this.supportedFormats.toText(),
            maxFileSizeMb: this.maxDownloadSizeMb,
            contact: this.authorContact,
        });
    }
}
