import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import type { Message } from "@grammyjs/types";
import { Tokens } from "app/shared/tokens";
import { Middleware } from "app/telegram/middleware/middleware";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";

// Answers a message a person sent with content other than a file: the commands stand above it and
// take theirs.
@injectable()
export class NotAFileMiddleware extends Middleware {
    // What a person sends, as opposed to a service message (a pin, an access granted from a mini
    // app), which is no message to the bot and gets no answer. A list of what is answered rather than
    // of what is not: Telegram adds service messages, and a new one stays unanswered. A document is
    // not in it, while a GIF is: Telegram also puts a GIF into `document`, but to a person it is no
    // file.
    private static readonly CONTENT_FIELDS: ReadonlyArray<keyof Message> = [
        "text",
        "photo",
        "animation",
        "sticker",
        "voice",
        "audio",
        "video",
        "video_note",
        "contact",
        "location",
        "poll",
        "dice",
    ];

    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        if (!this.hasContent(ctx.message)) {
            return next();
        }

        await ctx.reply(ctx.t("not-a-file-middleware-hint", { formats: this.supportedFormats.toText() }));
    }

    private hasContent(message: Message | undefined): boolean {
        if (message === undefined) {
            return false;
        }

        return NotAFileMiddleware.CONTENT_FIELDS.some((field) => message[field] !== undefined);
    }
}
