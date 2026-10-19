import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Api, Composer, Context as GrammyContext, GrammyError } from "grammy";
import type { InlineKeyboardMarkup, InputMediaDocument, MaybeInaccessibleMessage, Message, Update, UserFromGetMe } from "@grammyjs/types";
import type { ConvertParams } from "app/font-convertor/font-convertor.types";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { FontConvertorError } from "app/font-convertor/font-convertor.errors";
import { ConversionMiddleware } from "app/telegram/middleware/conversion/conversion.middleware";
import type { TelegramFileDownloader } from "app/telegram/file-downloader/telegram-file-downloader";
import { PathFile } from "app/telegram/path-file/path-file";
import { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import type { Context } from "app/telegram/bot/bot.types";
import { createFluent } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { supportedFormats } from "test/telegram/handler.helper";
import { realConvertorFactory, realFontValidatorResolver } from "test/font-convertor/convertor-factory.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { telegramError } from "test/telegram/telegram-bot-api-failure-classifier.helper";

const FONTS_DIR = path.join(process.cwd(), "test", "fixtures", "fonts");
const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;
const CHAT = { id: 1, type: "private", first_name: "User" } as const;
const SENDER = { id: 1, is_bot: false, first_name: "User" };
const SOURCE_MESSAGE_ID = 42;
const QUESTION_MESSAGE_ID = 43;
const MAX_UPLOAD_SIZE_MB = 50;
const BYTES_PER_MB = 1024 * 1024;
// The margin ConversionMiddleware keeps under the upload limit for the multipart around the files.
const REQUEST_OVERHEAD_MARGIN_BYTES = 64 * 1024;

// A message as a reply carries it: without a reply of its own.
type ReplyMessage = NonNullable<Message["reply_to_message"]>;

// What a handler called on the context, in order: the method and its first two arguments.
type HandlerCall = { method: string; args: unknown[] };

type PressRun = { calls: HandlerCall[]; isPassedOn: boolean };

// Stands for Telegram: hands out a copy of the fixture of the extension as a file of the temporary
// directory.
class FakeFileDownloader {
    public readonly downloadedPaths: string[] = [];

    public constructor(private readonly tempDir: string) {}

    public async download(_api: unknown, _fileId: string, extension: Extension): Promise<string> {
        const downloadedPath = path.join(this.tempDir, `source-${this.downloadedPaths.length}.${extension}`);

        await fs.copyFile(path.join(FONTS_DIR, `test-font.${extension}`), downloadedPath);
        this.downloadedPaths.push(downloadedPath);

        return downloadedPath;
    }
}

// The message of a font as the intake took it.
function sourceMessage(fileName: string): ReplyMessage {
    return {
        message_id: SOURCE_MESSAGE_ID,
        date: 1,
        chat: CHAT,
        from: SENDER,
        document: { file_id: "file-id", file_unique_id: "file-unique-id", file_name: fileName },
    } as ReplyMessage;
}

// The question of the intake in reply to the source, or standing alone when the source is gone, with
// the buttons as they were at the press.
function question(source: ReplyMessage | undefined, keyboard?: InlineKeyboardMarkup): Message {
    return {
        message_id: QUESTION_MESSAGE_ID,
        date: 2,
        chat: CHAT,
        from: ME,
        text: "Это WOFF. Во что сконвертировать?",
        reply_to_message: source,
        reply_markup: keyboard,
    } as Message;
}

// The buttons the intake puts under the question of a WOFF source (docs/product/cjm.md, step 2).
function woffButtons(): InlineKeyboardMarkup {
    return {
        inline_keyboard: [
            [
                { text: "TTF", callback_data: "convert:ttf" },
                { text: "OTF", callback_data: "convert:otf" },
                { text: "WOFF2", callback_data: "convert:woff2" },
            ],
            [
                { text: "EOT", callback_data: "convert:eot" },
                { text: "SVG", callback_data: "convert:svg" },
            ],
            [{ text: "Все форматы", callback_data: "convert:all" }],
        ],
    };
}

function press(data: string, message: MaybeInaccessibleMessage): Update {
    return {
        update_id: 1,
        callback_query: { id: "query-id", chat_instance: "1", from: SENDER, data: data, message: message },
    };
}

describe("ConversionMiddleware", function () {
    let tempDir: string;
    let downloader: FakeFileDownloader;
    let logger: RecordingLogger;

    beforeEach(async function () {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conversion-middleware-"));
        downloader = new FakeFileDownloader(tempDir);
        logger = new RecordingLogger();
    });

    afterEach(async function () {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function middlewareWith(fontConvertor: FontConvertor, maxUploadSizeMb: number = MAX_UPLOAD_SIZE_MB): ConversionMiddleware {
        return new ConversionMiddleware(
            supportedFormats,
            downloader as unknown as TelegramFileDownloader,
            fontConvertor,
            new FormatButtons(supportedFormats),
            new TelegramBotApiFailureClassifier(),
            logger,
            maxUploadSizeMb,
        );
    }

    function realConvertor(): FontConvertor {
        const resolver = realFontValidatorResolver();

        return new FontConvertor(realConvertorFactory(resolver), resolver, tempDir);
    }

    function realMiddleware(): ConversionMiddleware {
        return middlewareWith(realConvertor());
    }

    // Runs the update through the middleware the way Bot attaches it, with the calls of the context
    // recorded instead of sent. answerPress stands for the answer of Telegram to answerCallbackQuery,
    // mediaGroupError for a failure of the first album the middleware sends, editError for a failure
    // of the edit of the buttons.
    async function run(
        middleware: ConversionMiddleware,
        update: Update,
        options: { locale?: Locale; answerPress?: () => Promise<true>; mediaGroupError?: Error; editError?: Error } = {},
    ): Promise<PressRun> {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const ctx = new GrammyContext(update, new Api("test-token"), ME) as Context;
        const calls: HandlerCall[] = [];
        const record =
            (method: string) =>
            async (...args: unknown[]): Promise<never> => {
                calls.push({ method: method, args: args });

                return {} as never;
            };

        ctx.t = fluent.withLocale(options.locale ?? DEFAULT_LOCALE);
        ctx.answerCallbackQuery = (async (...args: unknown[]) => {
            calls.push({ method: "answerCallbackQuery", args: args });

            return options.answerPress === undefined ? true : await options.answerPress();
        }) as Context["answerCallbackQuery"];
        ctx.replyWithChatAction = record("replyWithChatAction") as Context["replyWithChatAction"];
        ctx.reply = record("reply") as Context["reply"];
        ctx.replyWithDocument = record("replyWithDocument") as Context["replyWithDocument"];
        ctx.replyWithMediaGroup = (async (...args: unknown[]) => {
            calls.push({ method: "replyWithMediaGroup", args: args });

            if (options.mediaGroupError !== undefined) {
                throw options.mediaGroupError;
            }

            return {};
        }) as Context["replyWithMediaGroup"];
        ctx.editMessageReplyMarkup = (async (...args: unknown[]) => {
            calls.push({ method: "editMessageReplyMarkup", args: args });

            if (options.editError !== undefined) {
                throw options.editError;
            }

            return true;
        }) as Context["editMessageReplyMarkup"];

        const composer = new Composer<Context>();
        middleware.setup(composer);
        let isPassedOn = false;

        await composer.middleware()(ctx, async () => {
            isPassedOn = true;
        });

        return { calls: calls, isPassedOn: isPassedOn };
    }

    function documentOf(calls: HandlerCall[]): PathFile {
        const documentCall = calls.find((call) => call.method === "replyWithDocument");

        return documentCall?.args[0] as PathFile;
    }

    function albumOf(calls: HandlerCall[]): InputMediaDocument<PathFile>[] {
        const albumCall = calls.find((call) => call.method === "replyWithMediaGroup");

        return albumCall?.args[0] as InputMediaDocument<PathFile>[];
    }

    function albumFilenames(calls: HandlerCall[]): unknown[] {
        return albumOf(calls).map((media) => (media.media as PathFile).filename);
    }

    // Converts as the real convertor does, and fails on our side for the targets named.
    function convertorFailingFor(failingExtensions: Extension[]): FontConvertor {
        const realFontConvertor = realConvertor();

        return {
            convert: async (params: ConvertParams): Promise<string> => {
                if (failingExtensions.includes(params.extension)) {
                    throw new FontConvertorError("The engine failed.");
                }

                return realFontConvertor.convert(params);
            },
        } as unknown as FontConvertor;
    }

    // The texts of the buttons the press edited the question into, or undefined when it edited nothing.
    function markedLooks(calls: HandlerCall[]): unknown {
        const editCall = calls.find((call) => call.method === "editMessageReplyMarkup");
        const editOptions = editCall?.args[0] as { reply_markup: InlineKeyboardMarkup } | undefined;

        return editOptions?.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text));
    }

    function replyTexts(calls: HandlerCall[]): unknown[] {
        return calls.filter((call) => call.method === "reply").map((call) => call.args[0]);
    }

    // The pair matrix is complete: every format converts into every other (docs/product/cjm.md, step 3).
    for (const sourceExtension of supportedFormats.toSourceList()) {
        for (const targetExtension of supportedFormats.toTargetList(sourceExtension)) {
            it(`sends ${sourceExtension} converted to ${targetExtension} as a document named after the source`, async function () {
                const { calls } = await run(
                    realMiddleware(),
                    press(`convert:${targetExtension}`, question(sourceMessage(`MyFont.${sourceExtension}`))),
                );
                const document = documentOf(calls);

                expect(document).to.be.instanceOf(PathFile);
                expect(document.filename).to.equal(`MyFont.${targetExtension}`);
                // The result is checked by the validator a source of its format meets.
                await realFontValidatorResolver().get(targetExtension).validate(document.path);
            });
        }
    }

    it("answers the press first, shows the upload while it converts, and sends the document in reply to the source", async function () {
        const { calls, isPassedOn } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"))));

        expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery", "replyWithChatAction", "replyWithDocument"]);
        expect(calls[1]?.args[0]).to.equal("upload_document");
        // No caption: the name and the reply already say what it is.
        expect(calls[2]?.args[1]).to.deep.equal({
            reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true },
        });
        expect(isPassedOn).to.equal(false);
    });

    it("keeps the name of the source and takes its extension in any case", async function () {
        const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("My.Font.WOFF"))));

        expect(documentOf(calls).filename).to.equal("My.Font.ttf");
    });

    // The second tap of a quick pair comes with the buttons from before the marks of the first one
    // (docs/product/cjm.md, step 4).
    it("converts again on a second press of the same unmarked button, downloading the source anew", async function () {
        const middleware = realMiddleware();
        const update = press("convert:ttf", question(sourceMessage("MyFont.woff")));

        const first = await run(middleware, update);
        const second = await run(middleware, update);

        expect(documentOf(first.calls).filename).to.equal("MyFont.ttf");
        expect(documentOf(second.calls).filename).to.equal("MyFont.ttf");
        expect(documentOf(second.calls).path).to.not.equal(documentOf(first.calls).path);
        expect(downloader.downloadedPaths).to.have.lengthOf(2);
    });

    it("removes the downloaded source and keeps the result for the outbox", async function () {
        const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"))));

        await Promise.all(downloader.downloadedPaths.map(async (downloadedPath) => expect(await exists(downloadedPath)).to.equal(false)));
        expect(await exists(documentOf(calls).path)).to.equal(true);
    });

    describe("a conversion that fails", function () {
        const failingConvertor = {
            convert: async (): Promise<string> => {
                throw new FontConvertorError("The engine failed.");
            },
        } as unknown as FontConvertor;

        it("tells the person the conversion failed on our side, in reply to the source, and logs it", async function () {
            const { calls } = await run(middlewareWith(failingConvertor), press("convert:otf", question(sourceMessage("MyFont.woff"))));

            expect(replyTexts(calls)).to.deep.equal([
                "Не получилось сконвертировать в OTF. Это ошибка на нашей стороне — попробуйте другой формат.",
            ]);
            expect(calls.find((call) => call.method === "reply")?.args[1]).to.deep.equal({
                reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true },
            });
            expect(documentOf(calls)).to.equal(undefined);
            expect(logger.errors.map((error) => error.message)).to.deep.equal(["The conversion failed."]);
        });

        it("tells it in the locale of the update", async function () {
            const { calls } = await run(middlewareWith(failingConvertor), press("convert:otf", question(sourceMessage("MyFont.woff"))), {
                locale: "en",
            });

            expect(replyTexts(calls)).to.deep.equal(["Could not convert to OTF. This is an error on our side: try another format."]);
        });

        it("removes the downloaded source", async function () {
            await run(middlewareWith(failingConvertor), press("convert:otf", question(sourceMessage("MyFont.woff"))));

            expect(downloader.downloadedPaths).to.have.lengthOf(1);
            expect(await exists(downloader.downloadedPaths[0] ?? "")).to.equal(false);
        });

        // The inbox picks the outcome of the update by the error (docs/architecture/inbox.md, "Failures").
        it("lets an error that is no failure of the conversion through", async function () {
            const error = new Error("The disk is gone.");
            const brokenConvertor = {
                convert: async (): Promise<string> => {
                    throw error;
                },
            } as unknown as FontConvertor;

            const caught = await run(middlewareWith(brokenConvertor), press("convert:otf", question(sourceMessage("MyFont.woff")))).catch(
                (rejection: unknown) => rejection,
            );

            expect(caught).to.equal(error);
            expect(await exists(downloader.downloadedPaths[0] ?? "")).to.equal(false);
        });
    });

    // Telegram refuses a request whose body is over its limit, and an album goes in one request.
    describe("results against the upload limit", function () {
        const maxUploadSizeMb = 1;
        // The files of one request: the limit less the margin the middleware keeps for the multipart.
        const maxRequestFilesBytes = BYTES_PER_MB - REQUEST_OVERHEAD_MARGIN_BYTES;
        const tooLargeSvg = "Не получилось отправить SVG: больше 1 МБ — Telegram не даёт ботам отправлять такие файлы.";

        // Writes a result of the size given for its target, so that the spec knows each size before the run.
        function sizedConvertor(resultSizesBytes: Partial<Record<Extension, number>>, resultFontPaths: string[] = []): FontConvertor {
            return {
                convert: async (params: ConvertParams): Promise<string> => {
                    const resultFontPath = path.join(tempDir, `result-${resultFontPaths.length}.${params.extension}`);

                    await fs.writeFile(resultFontPath, Buffer.alloc(resultSizesBytes[params.extension] ?? 1));
                    resultFontPaths.push(resultFontPath);

                    return resultFontPath;
                },
            } as unknown as FontConvertor;
        }

        function filenamesOf(call: HandlerCall): unknown[] {
            if (call.method === "replyWithDocument") {
                return [(call.args[0] as PathFile).filename];
            }

            return (call.args[0] as InputMediaDocument<PathFile>[]).map((media) => (media.media as PathFile).filename);
        }

        function sendCalls(calls: HandlerCall[]): HandlerCall[] {
            return calls.filter((call) => call.method === "replyWithDocument" || call.method === "replyWithMediaGroup");
        }

        it("tells the person instead of sending a result over the limit, removes it and logs it", async function () {
            const resultFontPaths: string[] = [];
            const { calls } = await run(
                middlewareWith(sizedConvertor({ [Extension.SVG]: maxRequestFilesBytes + 1 }, resultFontPaths), maxUploadSizeMb),
                press("convert:svg", question(sourceMessage("MyFont.woff"))),
            );

            expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery", "replyWithChatAction", "reply"]);
            expect(replyTexts(calls)).to.deep.equal([tooLargeSvg]);
            expect(calls.at(-1)?.args[1]).to.deep.equal({
                reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true },
            });
            expect(await exists(resultFontPaths[0] ?? "")).to.equal(false);
            expect(logger.warnings).to.deep.equal([
                {
                    message: "The result is too large to send.",
                    payload: { sourceFilename: "MyFont.woff", targetExtension: Extension.SVG, resultSizeBytes: maxRequestFilesBytes + 1 },
                },
            ]);
        });

        it("marks the format whose result is over the limit with a cross", async function () {
            const { calls } = await run(
                middlewareWith(sizedConvertor({ [Extension.SVG]: maxRequestFilesBytes + 1 }), maxUploadSizeMb),
                press("convert:svg", question(sourceMessage("MyFont.woff"), woffButtons())),
            );

            expect(markedLooks(calls)).to.deep.equal([["TTF", "OTF", "WOFF2"], ["EOT", "✗ SVG"], ["Все форматы"]]);
        });

        it("sends a result of exactly the limit", async function () {
            const { calls } = await run(
                middlewareWith(sizedConvertor({ [Extension.SVG]: maxRequestFilesBytes }), maxUploadSizeMb),
                press("convert:svg", question(sourceMessage("MyFont.woff"))),
            );

            expect(documentOf(calls).filename).to.equal("MyFont.svg");
            expect(replyTexts(calls)).to.deep.equal([]);
        });

        it("sends the other formats as an album and names the one too large after the failed ones", async function () {
            const convertor = sizedConvertor({ [Extension.SVG]: maxRequestFilesBytes + 1 });
            const failingOtf = {
                convert: async (params: ConvertParams): Promise<string> => {
                    if (params.extension === Extension.OTF) {
                        throw new FontConvertorError("The engine failed.");
                    }

                    return convertor.convert(params);
                },
            } as unknown as FontConvertor;
            const { calls } = await run(
                middlewareWith(failingOtf, maxUploadSizeMb),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );

            expect(calls.map((call) => call.method)).to.deep.equal([
                "answerCallbackQuery",
                "replyWithChatAction",
                "replyWithMediaGroup",
                "reply",
                "reply",
            ]);
            expect(albumFilenames(calls)).to.deep.equal(["MyFont.ttf", "MyFont.woff2", "MyFont.eot"]);
            expect(replyTexts(calls)).to.deep.equal(["Не получилось: OTF.", tooLargeSvg]);
        });

        it("sends results that add up past the limit in several calls, in the order of the buttons", async function () {
            const thirdOfLimitBytes = Math.floor(maxRequestFilesBytes / 3);
            const { calls } = await run(
                middlewareWith(
                    sizedConvertor({
                        [Extension.TTF]: thirdOfLimitBytes,
                        [Extension.OTF]: thirdOfLimitBytes,
                        [Extension.WOFF2]: thirdOfLimitBytes,
                        [Extension.EOT]: maxRequestFilesBytes - thirdOfLimitBytes,
                        [Extension.SVG]: thirdOfLimitBytes,
                    }),
                    maxUploadSizeMb,
                ),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );
            const sent = sendCalls(calls);

            expect(sent.map((call) => call.method)).to.deep.equal(["replyWithMediaGroup", "replyWithMediaGroup"]);
            expect(sent.map((call) => filenamesOf(call))).to.deep.equal([
                ["MyFont.ttf", "MyFont.otf", "MyFont.woff2"],
                ["MyFont.eot", "MyFont.svg"],
            ]);
            expect(sent.map((call) => call.args[1])).to.deep.equal([
                { reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true } },
                { reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true } },
            ]);
            expect(replyTexts(calls)).to.deep.equal([]);
        });

        it("sends a result left alone by the limit as a plain document", async function () {
            const halfOfLimitBytes = Math.floor(maxRequestFilesBytes / 2);
            const { calls } = await run(
                middlewareWith(
                    sizedConvertor({
                        [Extension.TTF]: halfOfLimitBytes,
                        [Extension.OTF]: halfOfLimitBytes,
                        [Extension.WOFF2]: halfOfLimitBytes + 1,
                        [Extension.EOT]: halfOfLimitBytes,
                        [Extension.SVG]: halfOfLimitBytes,
                    }),
                    maxUploadSizeMb,
                ),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );
            const sent = sendCalls(calls);

            expect(sent.map((call) => call.method)).to.deep.equal(["replyWithMediaGroup", "replyWithDocument", "replyWithMediaGroup"]);
            expect(sent.map((call) => filenamesOf(call))).to.deep.equal([
                ["MyFont.ttf", "MyFont.otf"],
                ["MyFont.woff2"],
                ["MyFont.eot", "MyFont.svg"],
            ]);
        });

        it("removes the results of the calls after a failed one and lets the error through", async function () {
            const error = new Error("The outbox did not answer in time.");
            const thirdOfLimitBytes = Math.floor(maxRequestFilesBytes / 3);
            const resultFontPaths: string[] = [];
            const convertor = sizedConvertor(
                {
                    [Extension.TTF]: thirdOfLimitBytes,
                    [Extension.OTF]: thirdOfLimitBytes,
                    [Extension.WOFF2]: thirdOfLimitBytes,
                    [Extension.EOT]: thirdOfLimitBytes,
                    [Extension.SVG]: thirdOfLimitBytes,
                },
                resultFontPaths,
            );

            const caught = await run(
                middlewareWith(convertor, maxUploadSizeMb),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
                {
                    mediaGroupError: error,
                },
            ).catch((rejection: unknown) => rejection);

            expect(caught).to.equal(error);
            // The first call carries TTF, OTF and WOFF2; it may still be sent, so its files stay for the outbox.
            const isKept = await Promise.all(resultFontPaths.map(async (resultFontPath) => exists(resultFontPath)));
            expect(isKept).to.deep.equal([true, true, true, false, false]);
        });

        it("tells it in the locale of the update", async function () {
            const { calls } = await run(
                middlewareWith(sizedConvertor({ [Extension.SVG]: maxRequestFilesBytes + 1 }), maxUploadSizeMb),
                press("convert:svg", question(sourceMessage("MyFont.woff"))),
                { locale: "en" },
            );

            expect(replyTexts(calls)).to.deep.equal(["Could not send SVG: over 1 MB. Telegram does not let bots send such files."]);
        });

        // The convertor wrote the file, so a size that cannot be read leaves it in no list to remove.
        it("removes a result whose size cannot be read and lets the error through", async function () {
            const resultFontPaths: string[] = [];
            const convertor = sizedConvertor({}, resultFontPaths);
            const missingResultPath = path.join(tempDir, "missing.svg");
            const vanishingConvertor = {
                convert: async (params: ConvertParams): Promise<string> => {
                    if (params.extension === Extension.SVG) {
                        return missingResultPath;
                    }

                    return convertor.convert(params);
                },
            } as unknown as FontConvertor;

            const caught = await run(
                middlewareWith(vanishingConvertor),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            ).catch((rejection: unknown) => rejection);

            expect((caught as NodeJS.ErrnoException).code).to.equal("ENOENT");
            await Promise.all(resultFontPaths.map(async (resultFontPath) => expect(await exists(resultFontPath)).to.equal(false)));
        });
    });

    describe("a source the bot can no longer get", function () {
        const sourceUnavailable = "Этот файл больше недоступен — пришлите его ещё раз.";

        it("asks for the file again when the source of the question was deleted", async function () {
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(undefined)));

            expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery", "reply"]);
            expect(replyTexts(calls)).to.deep.equal([sourceUnavailable]);
            expect(downloader.downloadedPaths).to.deep.equal([]);
        });

        // The Bot API gives a question older than a bot may read as an inaccessible message: its chat,
        // its id and a date of 0.
        it("asks for the file again when the question is no longer accessible", async function () {
            const { calls } = await run(realMiddleware(), press("convert:ttf", { chat: CHAT, message_id: QUESTION_MESSAGE_ID, date: 0 }));

            expect(replyTexts(calls)).to.deep.equal([sourceUnavailable]);
        });

        it("asks for the file again when the message replied to holds no file", async function () {
            const textMessage = { message_id: SOURCE_MESSAGE_ID, date: 1, chat: CHAT, from: SENDER, text: "hello" } as ReplyMessage;
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(textMessage)));

            expect(replyTexts(calls)).to.deep.equal([sourceUnavailable]);
        });

        it("asks in the locale of the update", async function () {
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(undefined)), { locale: "en" });

            expect(replyTexts(calls)).to.deep.equal(["This file is no longer available: please send it again."]);
        });
    });

    describe("the answer to the press", function () {
        // Telegram waits for the answer for a short while only: a press the inbox handed out late, or
        // handles again after a failure, gets this refusal.
        it("converts a press Telegram no longer takes the answer to", async function () {
            const tooOld = new GrammyError(
                "Call to 'answerCallbackQuery' failed!",
                {
                    ok: false,
                    error_code: 400,
                    description: "Bad Request: query is too old and response timeout expired or query ID is invalid",
                },
                "answerCallbackQuery",
                {},
            );
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"))), {
                answerPress: async () => {
                    throw tooOld;
                },
            });

            expect(documentOf(calls).filename).to.equal("MyFont.ttf");
            expect(logger.infos.map((info) => info.message)).to.deep.equal(["The press was answered too late."]);
        });

        it("lets any other failure of the answer through", async function () {
            const badRequest = new GrammyError(
                "Call to 'answerCallbackQuery' failed!",
                { ok: false, error_code: 400, description: "Bad Request: message text is empty" },
                "answerCallbackQuery",
                {},
            );

            const caught = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"))), {
                answerPress: async () => {
                    throw badRequest;
                },
            }).catch((rejection: unknown) => rejection);

            expect(caught).to.equal(badRequest);
            expect(downloader.downloadedPaths).to.deep.equal([]);
        });
    });

    // docs/product/cjm.md, step 3: "Все форматы".
    describe("a press of all formats", function () {
        const sourceReply = { reply_parameters: { message_id: SOURCE_MESSAGE_ID, allow_sending_without_reply: true } };

        it("sends every offered format as one album of documents in reply to the source, from one download", async function () {
            const { calls } = await run(realMiddleware(), press("convert:all", question(sourceMessage("MyFont.woff"))));

            expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery", "replyWithChatAction", "replyWithMediaGroup"]);
            expect(albumOf(calls).map((media) => media.type)).to.deep.equal(["document", "document", "document", "document", "document"]);
            expect(albumFilenames(calls)).to.deep.equal(["MyFont.ttf", "MyFont.otf", "MyFont.woff2", "MyFont.eot", "MyFont.svg"]);
            // No caption, as for a single format.
            expect(albumOf(calls).map((media) => media.caption)).to.deep.equal([undefined, undefined, undefined, undefined, undefined]);
            expect(calls.at(-1)?.args[1]).to.deep.equal(sourceReply);
            // The source is removed, and the results are kept for the outbox.
            expect(downloader.downloadedPaths).to.have.lengthOf(1);
            expect(await exists(downloader.downloadedPaths[0] ?? "")).to.equal(false);
            await Promise.all(albumOf(calls).map(async (media) => expect(await exists((media.media as PathFile).path)).to.equal(true)));
        });

        it("sends the rest as an album and names the failed formats in one message after it", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.OTF, Extension.SVG])),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );

            expect(calls.map((call) => call.method)).to.deep.equal([
                "answerCallbackQuery",
                "replyWithChatAction",
                "replyWithMediaGroup",
                "reply",
            ]);
            expect(albumFilenames(calls)).to.deep.equal(["MyFont.ttf", "MyFont.woff2", "MyFont.eot"]);
            expect(replyTexts(calls)).to.deep.equal(["Не получилось: OTF, SVG."]);
            expect(calls.at(-1)?.args[1]).to.deep.equal(sourceReply);
            expect(logger.errors.map((error) => error.message)).to.deep.equal(["The conversion failed.", "The conversion failed."]);
        });

        it("names the failed formats in the locale of the update", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.OTF, Extension.SVG])),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
                { locale: "en" },
            );

            expect(replyTexts(calls)).to.deep.equal(["Could not convert: OTF, SVG."]);
        });

        // A Telegram album holds at least two files.
        it("sends a single result as a plain document", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.OTF, Extension.WOFF2, Extension.EOT, Extension.SVG])),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );

            expect(calls.map((call) => call.method)).to.deep.equal([
                "answerCallbackQuery",
                "replyWithChatAction",
                "replyWithDocument",
                "reply",
            ]);
            expect(documentOf(calls).filename).to.equal("MyFont.ttf");
            expect(calls.find((call) => call.method === "replyWithDocument")?.args[1]).to.deep.equal(sourceReply);
            expect(replyTexts(calls)).to.deep.equal(["Не получилось: OTF, WOFF2, EOT, SVG."]);
        });

        it("answers with the failed formats alone when every conversion fails", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.TTF, Extension.OTF, Extension.WOFF2, Extension.EOT, Extension.SVG])),
                press("convert:all", question(sourceMessage("MyFont.woff"))),
            );

            expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery", "replyWithChatAction", "reply"]);
            expect(replyTexts(calls)).to.deep.equal(["Не получилось: TTF, OTF, WOFF2, EOT, SVG."]);
            expect(await exists(downloader.downloadedPaths[0] ?? "")).to.equal(false);
        });

        // The inbox handles the update again from the start, so the results made before the error
        // would never be sent.
        it("removes the results already made when an error that is no failure of the conversion stops it", async function () {
            const error = new Error("The disk is gone.");
            const realFontConvertor = realConvertor();
            const resultFontPaths: string[] = [];
            const brokenConvertor = {
                convert: async (params: ConvertParams): Promise<string> => {
                    if (params.extension === Extension.WOFF2) {
                        throw error;
                    }

                    const resultFontPath = await realFontConvertor.convert(params);
                    resultFontPaths.push(resultFontPath);

                    return resultFontPath;
                },
            } as unknown as FontConvertor;

            const caught = await run(middlewareWith(brokenConvertor), press("convert:all", question(sourceMessage("MyFont.woff")))).catch(
                (rejection: unknown) => rejection,
            );

            expect(caught).to.equal(error);
            expect(resultFontPaths).to.have.lengthOf(2);
            await Promise.all(resultFontPaths.map(async (resultFontPath) => expect(await exists(resultFontPath)).to.equal(false)));
            expect(await exists(downloader.downloadedPaths[0] ?? "")).to.equal(false);
        });
    });

    // docs/product/cjm.md, step 4.
    describe("the marks of the buttons", function () {
        const notModified = telegramError(
            400,
            "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
        );

        it("marks the format sent with a tick, after the document", async function () {
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"), woffButtons())));

            expect(calls.map((call) => call.method)).to.deep.equal([
                "answerCallbackQuery",
                "replyWithChatAction",
                "replyWithDocument",
                "editMessageReplyMarkup",
            ]);
            expect(markedLooks(calls)).to.deep.equal([["✓ TTF", "OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
        });

        it("marks a format that failed on our side with a cross, after the message about it", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.OTF])),
                press("convert:otf", question(sourceMessage("MyFont.woff"), woffButtons())),
            );

            expect(calls.map((call) => call.method)).to.deep.equal([
                "answerCallbackQuery",
                "replyWithChatAction",
                "reply",
                "editMessageReplyMarkup",
            ]);
            expect(markedLooks(calls)).to.deep.equal([["TTF", "✗ OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
        });

        it("marks every format by its own outcome after all formats", async function () {
            const { calls } = await run(
                middlewareWith(convertorFailingFor([Extension.OTF, Extension.SVG])),
                press("convert:all", question(sourceMessage("MyFont.woff"), woffButtons())),
            );

            expect(markedLooks(calls)).to.deep.equal([["✓ TTF", "✗ OTF", "✓ WOFF2"], ["✓ EOT", "✗ SVG"], ["Все форматы"]]);
        });

        // A press of OTF made while TTF converted comes with the buttons from before the tick of TTF, and
        // nothing else tells the bot of it: the keyboard is the only record of the marks.
        it("drops the marks of an earlier press that came after the press of another button", async function () {
            const middleware = realMiddleware();

            const first = await run(middleware, press("convert:ttf", question(sourceMessage("MyFont.woff"), woffButtons())));
            const second = await run(middleware, press("convert:otf", question(sourceMessage("MyFont.woff"), woffButtons())));

            expect(markedLooks(first.calls)).to.deep.equal([["✓ TTF", "OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
            expect(markedLooks(second.calls)).to.deep.equal([["TTF", "✓ OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
        });

        // Telegram refuses an edit that changes nothing with a 400.
        it("edits nothing when the buttons carry the marks already", async function () {
            const failingConvertor = convertorFailingFor([Extension.OTF, Extension.SVG]);
            const first = await run(
                middlewareWith(failingConvertor),
                press("convert:all", question(sourceMessage("MyFont.woff"), woffButtons())),
            );
            const editOptions = first.calls.at(-1)?.args[0] as { reply_markup: InlineKeyboardMarkup };

            const second = await run(
                middlewareWith(failingConvertor),
                press("convert:all", question(sourceMessage("MyFont.woff"), editOptions.reply_markup)),
            );

            expect(second.calls.map((call) => call.method)).to.not.include("editMessageReplyMarkup");
        });

        // The second tap of a quick pair, or a press the inbox handles again after its edit went out.
        it("goes on when Telegram refuses the edit as changing nothing, and logs it", async function () {
            const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"), woffButtons())), {
                editError: notModified,
            });

            expect(documentOf(calls).filename).to.equal("MyFont.ttf");
            expect(logger.infos).to.deep.equal([{ message: "The buttons were not marked.", payload: { cause: notModified } }]);
        });

        it("goes on when the question was deleted during the conversion", async function () {
            const notFound = telegramError(400, "Bad Request: message to edit not found");

            const { calls } = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"), woffButtons())), {
                editError: notFound,
            });

            expect(documentOf(calls).filename).to.equal("MyFont.ttf");
            expect(logger.infos.map((info) => info.message)).to.deep.equal(["The buttons were not marked."]);
        });

        // The inbox picks the outcome of the update by the error (docs/architecture/inbox.md, "Failures").
        it("lets any other failure of the edit through", async function () {
            const malformed = telegramError(400, "Bad Request: can't parse reply keyboard markup JSON object");

            const caught = await run(realMiddleware(), press("convert:ttf", question(sourceMessage("MyFont.woff"), woffButtons())), {
                editError: malformed,
            }).catch((rejection: unknown) => rejection);

            expect(caught).to.equal(malformed);
        });

        describe("a press of a marked button", function () {
            for (const { data, toast } of [
                { data: "sent:ttf", toast: "TTF уже отправлен — он выше в чате." },
                { data: "failed:svg", toast: "SVG из этого файла не получается — повтор даст то же самое." },
            ]) {
                it(`answers "${data}" with a toast and converts nothing`, async function () {
                    const { calls, isPassedOn } = await run(realMiddleware(), press(data, question(sourceMessage("MyFont.woff"))));

                    expect(calls).to.deep.equal([{ method: "answerCallbackQuery", args: [toast] }]);
                    expect(downloader.downloadedPaths).to.deep.equal([]);
                    expect(isPassedOn).to.equal(false);
                });
            }

            it("answers in the locale of the update", async function () {
                const sent = await run(realMiddleware(), press("sent:ttf", question(sourceMessage("MyFont.woff"))), { locale: "en" });
                const failed = await run(realMiddleware(), press("failed:svg", question(sourceMessage("MyFont.woff"))), { locale: "en" });

                expect(sent.calls[0]?.args).to.deep.equal(["TTF has already been sent: it is above in the chat."]);
                expect(failed.calls[0]?.args).to.deep.equal(["SVG cannot be made from this file: trying again gives the same."]);
            });
        });
    });

    // The source format is never offered: such data comes from no button of the bot.
    for (const data of ["convert:woff", "convert:pdf"]) {
        it(`answers a press of "${data}", which names no pair of the source, and logs it`, async function () {
            const { calls } = await run(realMiddleware(), press(data, question(sourceMessage("MyFont.woff"))));

            expect(calls.map((call) => call.method)).to.deep.equal(["answerCallbackQuery"]);
            expect(logger.warnings.map((warning) => warning.message)).to.deep.equal(["The button names no pair of its source."]);
        });
    }

    it("passes a press of another button on", async function () {
        const { calls, isPassedOn } = await run(realMiddleware(), press("other:ttf", question(sourceMessage("MyFont.woff"))));

        expect(calls).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    it("passes a message on", async function () {
        const message: Update = {
            update_id: 1,
            message: { message_id: SOURCE_MESSAGE_ID, date: 1, chat: CHAT, from: SENDER, text: "hello" },
        };
        const { calls, isPassedOn } = await run(realMiddleware(), message);

        expect(calls).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });
});

async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
        () => true,
        () => false,
    );
}
