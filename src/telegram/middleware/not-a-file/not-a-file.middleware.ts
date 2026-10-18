import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import { Tokens } from "app/shared/tokens";
import { Middleware } from "app/telegram/middleware/middleware";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

// Answers every message but a document: the commands stand above it and take theirs.
@injectable()
export class NotAFileMiddleware extends Middleware {
    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (ctx.message === undefined || ctx.message.document !== undefined) {
            return next();
        }

        await ctx.reply(ctx.t("not-a-file-middleware-hint", { formats: this.supportedFormats.toText() }));
    }
}
