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
        "story",
        "paid_media",
        "contact",
        "location",
        "venue",
        "poll",
        "checklist",
        "dice",
        "game",
        "giveaway",
        "giveaway_winners",
        "invoice",
    ];

    public constructor(@inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        const message = ctx.message;

        if (message === undefined || !this.hasContentOtherThanFile(message)) {
            return next();
        }

        // An album comes as one message per item, each an update of its own, so its first item alone
        // gets the hint. The inbox hands out the updates of a session one at a time, in their order.
        if (message.media_group_id !== undefined && message.media_group_id === ctx.session.hintedMediaGroupId) {
            return;
        }

        if (message.media_group_id !== undefined) {
            ctx.session.hintedMediaGroupId = message.media_group_id;
        }

        await ctx.reply(ctx.t("not-a-file-middleware-hint", { formats: this.supportedFormats.toSourceText() }));
    }

    private hasContentOtherThanFile(message: Message): boolean {
        return NotAFileMiddleware.CONTENT_FIELDS.some((field) => message[field] !== undefined);
    }
}
