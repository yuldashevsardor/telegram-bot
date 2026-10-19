import path from "path";
import { constants as httpStatus } from "node:http2";
import { inject, injectable } from "inversify";
import type { NextFunction } from "grammy";
import { GrammyError, InputMediaBuilder } from "grammy";
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

type Conversion = { sourceExtension: Extension; targetExtensions: Extension[]; isAllFormats: boolean };

type Result = { targetExtension: Extension; resultFontPath: string };

type Outcome = { results: Result[]; failedExtensions: Extension[] };

type ReplyOptions = { reply_parameters: { message_id: number; allow_sending_without_reply: boolean } };

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
        const source = this.findSource(ctx);

        if (source === undefined) {
            await ctx.reply(ctx.t("conversion-middleware-source-unavailable"));

            return;
        }

        const sourceFilename = source.document.file_name ?? "";
        const conversion = await this.findConversion(sourceFilename, targetName);

        // The bot offers no such button: the pair matrix changed under an old question, or a client
        // sent data of its own.
        if (conversion === undefined) {
            this.logger.warning("The button names no pair of its source.", { sourceFilename: sourceFilename, callbackData: callbackData });

            return;
        }

        await ctx.replyWithChatAction("upload_document");

        const sourceFontPath = await this.fileDownloader.download(ctx.api, source.document.file_id, conversion.sourceExtension);
        const outcome = await this.convert(sourceFontPath, conversion);
        const replyOptions = {
            // The source deleted meanwhile would fail a reply that requires it, and the failed call would
            // block the chat in the outbox.
            reply_parameters: { message_id: source.messageId, allow_sending_without_reply: true },
        };

        await this.sendResults(ctx, sourceFilename, outcome.results, replyOptions);

        const [firstFailedExtension] = outcome.failedExtensions;

        if (firstFailedExtension === undefined) {
            return;
        }

        if (conversion.isAllFormats) {
            const failedFormats = outcome.failedExtensions.map((extension) => extension.toUpperCase()).join(", ");

            await ctx.reply(ctx.t("conversion-middleware-failed-formats", { formats: failedFormats }), replyOptions);

            return;
        }

        // A press of one format converts into it alone, so it is the one that failed.
        await ctx.reply(ctx.t("conversion-middleware-failed", { format: firstFailedExtension.toUpperCase() }), replyOptions);
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
    // targets among the ones the buttons offer for it: the one the button names, or all of them.
    private async findConversion(sourceFilename: string, targetName: string): Promise<Conversion | undefined> {
        const nameExtension = (await FileHelper.getFileExtension(sourceFilename)).toLowerCase();
        const sourceExtension = this.supportedFormats.toSourceList().find((extension) => extension === nameExtension);

        if (sourceExtension === undefined) {
            return undefined;
        }

        const offeredExtensions = this.supportedFormats.toTargetList(sourceExtension);

        if (targetName === FormatButtons.ALL_FORMATS) {
            return { sourceExtension: sourceExtension, targetExtensions: offeredExtensions, isAllFormats: true };
        }

        const targetExtension = offeredExtensions.find((extension) => extension === targetName);

        if (targetExtension === undefined) {
            return undefined;
        }

        return { sourceExtension: sourceExtension, targetExtensions: [targetExtension], isAllFormats: false };
    }

    // The downloaded source serves this press alone: the next press downloads it again.
    private async convert(sourceFontPath: string, conversion: Conversion): Promise<Outcome> {
        const outcome: Outcome = { results: [], failedExtensions: [] };

        try {
            for (const targetExtension of conversion.targetExtensions) {
                const resultFontPath = await this.convertTo(sourceFontPath, conversion.sourceExtension, targetExtension);

                if (resultFontPath === undefined) {
                    outcome.failedExtensions.push(targetExtension);
                } else {
                    outcome.results.push({ targetExtension: targetExtension, resultFontPath: resultFontPath });
                }
            }
        } catch (error) {
            // The results already made would never reach the outbox, which removes the files it sends.
            for (const result of outcome.results) {
                await this.removeFile(result.resultFontPath);
            }

            throw error;
        } finally {
            await this.removeFile(sourceFontPath);
        }

        return outcome;
    }

    // undefined for a conversion that failed on our side: the person is told, and the other targets
    // of "all formats" still go.
    private async convertTo(sourceFontPath: string, sourceExtension: Extension, targetExtension: Extension): Promise<string | undefined> {
        try {
            return await this.fontConvertor.convert({ originPath: sourceFontPath, extension: targetExtension });
        } catch (error) {
            if (!(error instanceof FontConvertorError)) {
                throw error;
            }

            this.logger.error("The conversion failed.", {
                sourceExtension: sourceExtension,
                targetExtension: targetExtension,
                cause: error,
            });

            return undefined;
        }
    }

    // A Telegram album holds at least two files, so a single result goes as a plain document.
    private async sendResults(ctx: Context, sourceFilename: string, results: Result[], replyOptions: ReplyOptions): Promise<void> {
        const resultFiles = results.map((result) => this.toResultFile(sourceFilename, result));
        const [firstResultFile] = resultFiles;

        if (firstResultFile === undefined) {
            return;
        }

        if (resultFiles.length === 1) {
            await ctx.replyWithDocument(firstResultFile, replyOptions);

            return;
        }

        await ctx.replyWithMediaGroup(
            resultFiles.map((resultFile) => InputMediaBuilder.document(resultFile)),
            replyOptions,
        );
    }

    // The domain names the result at random; the person gets the name of the source. The outbox
    // removes the file once the document is sent (docs/architecture/outbox.md, "Sending").
    private toResultFile(sourceFilename: string, result: Result): PathFile {
        const resultFilename = path.parse(sourceFilename).name + "." + result.targetExtension;

        return new PathFile(result.resultFontPath, resultFilename);
    }

    // A file left behind costs disk space alone, so its removal keeps neither the document from the
    // person nor the error of the conversion from the caller.
    private async removeFile(fontPath: string): Promise<void> {
        try {
            await FileHelper.remove(fontPath);
        } catch (error) {
            this.logger.warning("The file was not removed.", { path: fontPath, cause: error });
        }
    }
}
