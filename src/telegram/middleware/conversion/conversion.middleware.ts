import path from "path";
import { constants as httpStatus } from "node:http2";
import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import { GrammyError } from "grammy";
import type { Document } from "@grammyjs/types";
import { Tokens } from "app/shared/tokens";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Extension } from "app/font-convertor/font-convertor.types";
import type { FontConvertor } from "app/font-convertor/font-convertor";
import { FontConvertorError } from "app/font-convertor/font-convertor.errors";
import { Middleware } from "app/telegram/middleware/middleware";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import type { TelegramFileDownloader } from "app/telegram/file-downloader/telegram-file-downloader";
import { PathFile } from "app/telegram/path-file/path-file";
import type { Logger } from "app/platform/logger/logger";

// The message of the source and its file.
type Source = { messageId: number; document: Document };

type Pair = { sourceExtension: Extension; targetExtension: Extension };

// Converts the file of the question a format button stands under (docs/product/cjm.md, steps 3-4).
// The source is taken from Telegram again, through the message the question replies to: the callback
// data names the target alone (FormatButtons).
@injectable()
export class ConversionMiddleware extends Middleware {
    // How the Bot API refuses the answer to a press it no longer waits for: a press that waited in the
    // inbox behind the conversions of the same chat, or one the inbox retries after a failure.
    private static readonly QUERY_TOO_OLD_DESCRIPTION = "query is too old";

    public constructor(
        @inject<SupportedFormats>(Tokens.Bot.SupportedFormats) private readonly supportedFormats: SupportedFormats,
        @inject<TelegramFileDownloader>(Tokens.Bot.TelegramFileDownloader) private readonly fileDownloader: TelegramFileDownloader,
        @inject<FontConvertor>(Tokens.Font.Convertor.Convertor) private readonly fontConvertor: FontConvertor,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {
        super();
    }

    protected async handle(ctx: Context, next: NextFunction): Promise<void> {
        const callbackData = ctx.callbackQuery?.data;

        if (callbackData === undefined || !callbackData.startsWith(FormatButtons.CALLBACK_DATA_PREFIX)) {
            return next();
        }

        // At once, so that the client stops its spinner: the conversion takes seconds.
        await this.answerPress(ctx);

        const targetName = callbackData.slice(FormatButtons.CALLBACK_DATA_PREFIX.length);

        // "All formats" converts nothing yet.
        if (targetName === FormatButtons.ALL_FORMATS) {
            return;
        }

        const source = this.findSource(ctx);

        if (source === undefined) {
            await ctx.reply(ctx.t("conversion-middleware-source-unavailable"));

            return;
        }

        const sourceFilename = source.document.file_name ?? "";
        const pair = await this.findPair(sourceFilename, targetName);

        // The bot offers no such button: the pair matrix changed under an old question, or a client
        // sent data of its own.
        if (pair === undefined) {
            this.logger.warning("The button names no pair of its source.", { sourceFilename: sourceFilename, callbackData: callbackData });

            return;
        }

        const { sourceExtension, targetExtension } = pair;

        await ctx.replyWithChatAction("upload_document");

        const sourceFontPath = await this.fileDownloader.download(ctx.api, source.document.file_id, sourceExtension);
        const replyParameters = {
            // The source deleted meanwhile would fail a reply that requires it, and the failed call would
            // block the chat in the outbox.
            reply_parameters: { message_id: source.messageId, allow_sending_without_reply: true },
        };
        let resultFontPath: string;

        try {
            resultFontPath = await this.convert(sourceFontPath, targetExtension);
        } catch (error) {
            if (!(error instanceof FontConvertorError)) {
                throw error;
            }

            this.logger.error("The conversion failed.", {
                sourceExtension: sourceExtension,
                targetExtension: targetExtension,
                cause: error,
            });
            await ctx.reply(ctx.t("conversion-middleware-failed", { format: targetExtension.toUpperCase() }), replyParameters);

            return;
        }

        // The domain names the result at random; the person gets the name of the source. The outbox
        // removes the file once the document is sent (docs/architecture/outbox.md, "Sending").
        const resultFilename = path.parse(sourceFilename).name + "." + targetExtension;

        await ctx.replyWithDocument(new PathFile(resultFontPath, resultFilename), replyParameters);
    }

    private async answerPress(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
        } catch (error) {
            if (!this.isQueryTooOld(error)) {
                throw error;
            }

            // The client stopped the spinner on its own by now; the conversion still goes.
            this.logger.info("The press was answered too late.", { callbackQueryId: ctx.callbackQuery?.id });
        }
    }

    private isQueryTooOld(error: unknown): boolean {
        return (
            error instanceof GrammyError &&
            error.error_code === httpStatus.HTTP_STATUS_BAD_REQUEST &&
            error.description.includes(ConversionMiddleware.QUERY_TOO_OLD_DESCRIPTION)
        );
    }

    // The question replies to its source. The Bot API gives no reply of a question older than it lets
    // a bot read (an inaccessible message), nor of one whose source was deleted.
    private findSource(ctx: Context): Source | undefined {
        const question = ctx.callbackQuery?.message;

        if (question === undefined || !("reply_to_message" in question)) {
            return undefined;
        }

        const sourceMessage = question.reply_to_message;

        if (sourceMessage?.document === undefined) {
            return undefined;
        }

        return { messageId: sourceMessage.message_id, document: sourceMessage.document };
    }

    // The source format by the name, as the intake took the file (FileIntakeMiddleware), and the
    // target among the ones the buttons offer for it.
    private async findPair(sourceFilename: string, targetName: string): Promise<Pair | undefined> {
        const nameExtension = (await FileHelper.getFileExtension(sourceFilename)).toLowerCase();
        const sourceExtension = this.supportedFormats.toSourceList().find((extension) => extension === nameExtension);

        if (sourceExtension === undefined) {
            return undefined;
        }

        const targetExtension = this.supportedFormats.toTargetList(sourceExtension).find((extension) => extension === targetName);

        if (targetExtension === undefined) {
            return undefined;
        }

        return { sourceExtension: sourceExtension, targetExtension: targetExtension };
    }

    // The downloaded source serves this conversion alone: the next press downloads it again.
    private async convert(sourceFontPath: string, targetExtension: Extension): Promise<string> {
        try {
            return await this.fontConvertor.convert({ originPath: sourceFontPath, extension: targetExtension });
        } finally {
            await this.removeSourceFont(sourceFontPath);
        }
    }

    // A file left behind costs disk space alone, so its removal keeps neither the document from the
    // person nor the error of the conversion from the caller.
    private async removeSourceFont(sourceFontPath: string): Promise<void> {
        try {
            await FileHelper.remove(sourceFontPath);
        } catch (error) {
            this.logger.warning("The downloaded file was not removed.", { path: sourceFontPath, cause: error });
        }
    }
}
