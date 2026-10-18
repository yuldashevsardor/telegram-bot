import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import type { Document } from "@grammyjs/types";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Extension } from "app/font-convertor/font-convertor.types";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { Middleware } from "app/telegram/middleware/middleware";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import type { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import type { TelegramFileDownloader } from "app/telegram/file-downloader/telegram-file-downloader";
import { TelegramFileTooBig } from "app/telegram/file-downloader/telegram-file-downloader.errors";
import type { FontRejectionClassifier } from "app/telegram/middleware/file-intake/font-rejection-classifier";
import { FontRejection } from "app/telegram/middleware/file-intake/font-rejection";
import type { Logger } from "app/platform/logger/logger";

// Takes a document and asks what to convert it into (docs/product/cjm.md, step 2). The checks go
// from the cheapest: the size and the name come with the message, the content needs a download.
@injectable()
export class FileIntakeMiddleware extends Middleware {
    private static readonly BYTES_PER_MB = 1024 * 1024;

    public constructor(
        @inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats,
        @inject<FormatButtons>(Tokens.Bot.FormatButtons) private readonly formatButtons: FormatButtons,
        @inject<TelegramFileDownloader>(Tokens.Bot.TelegramFileDownloader) private readonly fileDownloader: TelegramFileDownloader,
        @inject<FontValidatorResolver>(Tokens.Font.Validator.Resolver) private readonly fontValidatorResolver: FontValidatorResolver,
        @inject<FontRejectionClassifier>(Tokens.Bot.FontRejectionClassifier)
        private readonly fontRejectionClassifier: FontRejectionClassifier,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly maxDownloadSizeMb: number = configValue("bot.maxDownloadSizeMb"),
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        const message = ctx.message;
        const document = message?.document;

        if (message === undefined || document === undefined) {
            return next();
        }

        // getFile refuses a file over the limit, so the size Telegram reports is all there is to go by.
        if (document.file_size !== undefined && document.file_size > this.maxDownloadSizeMb * FileIntakeMiddleware.BYTES_PER_MB) {
            await ctx.reply(ctx.t("file-intake-middleware-too-large", { maxDownloadSizeMb: this.maxDownloadSizeMb }));

            return;
        }

        const sourceExtension = await this.findSupportedExtension(document);

        if (sourceExtension === undefined) {
            await this.replyUnsupported(ctx, document);

            return;
        }

        let sourceFontPath: string;

        // A document without a size, or a limit set above the one of getFile, finds the size out here.
        // The limit of the server is unknown to the bot, so the text names no number.
        try {
            sourceFontPath = await this.fileDownloader.download(ctx.api, document.file_id, sourceExtension);
        } catch (error) {
            if (!(error instanceof TelegramFileTooBig)) {
                throw error;
            }

            await ctx.reply(ctx.t("file-intake-middleware-too-large-for-telegram"));

            return;
        }

        const format = sourceExtension.toUpperCase();
        const rejection = await this.validate(sourceFontPath, sourceExtension);

        if (rejection !== undefined) {
            await ctx.reply(this.rejectionText(ctx, rejection, format));

            return;
        }

        await ctx.reply(ctx.t("file-intake-middleware-question", { format: format }), {
            // A document deleted during the check would fail a reply that requires it, and the failed
            // call would block the chat. The question then stands alone, and the conversion finds no
            // source for it.
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
            reply_markup: this.formatButtons.build(ctx, sourceExtension),
        });
    }

    private async findSupportedExtension(document: Document): Promise<Extension | undefined> {
        const nameExtension = (await FileHelper.getFileExtension(document.file_name ?? "")).toLowerCase();

        return this.supportedFormats.toSourceList().find((extension) => extension === nameExtension);
    }

    // The Bot API does not promise a document a name, though the clients of Telegram always send one.
    private async replyUnsupported(ctx: Context, document: Document): Promise<void> {
        const formats = this.supportedFormats.toText();

        if (document.file_name === undefined) {
            await ctx.reply(ctx.t("file-intake-middleware-unsupported-unnamed", { formats: formats }));

            return;
        }

        await ctx.reply(ctx.t("file-intake-middleware-unsupported", { filename: document.file_name, formats: formats }));
    }

    private rejectionText(ctx: Context, rejection: FontRejection, format: string): string {
        if (rejection === FontRejection.NotInFormat) {
            return ctx.t("file-intake-middleware-not-in-format", { format: format });
        }

        return ctx.t("file-intake-middleware-broken", { format: format });
    }

    // The download serves the check alone: the conversion takes the file from Telegram again, by the
    // message the question replies to.
    private async validate(sourceFontPath: string, sourceExtension: Extension): Promise<FontRejection | undefined> {
        try {
            await this.fontValidatorResolver.get(sourceExtension).validate(sourceFontPath);

            return undefined;
        } catch (error) {
            const rejection = this.fontRejectionClassifier.classify(sourceExtension, error);

            if (rejection === undefined) {
                throw error;
            }

            return rejection;
        } finally {
            await this.removeSourceFont(sourceFontPath);
        }
    }

    // A file left behind costs disk space alone, so its removal does not keep the answer from the
    // person, nor does its error displace the one of the check.
    private async removeSourceFont(sourceFontPath: string): Promise<void> {
        try {
            await FileHelper.remove(sourceFontPath);
        } catch (error) {
            this.logger.warning("The downloaded file was not removed.", { path: sourceFontPath, cause: error });
        }
    }
}
