import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { InlineKeyboard } from "grammy";
import type { Document, Message } from "@grammyjs/types";
import type { Extension } from "app/font-convertor/font-convertor.types";
import { FileIntakeMiddleware } from "app/telegram/middleware/file-intake/file-intake.middleware";
import { FontRejectionClassifier } from "app/telegram/middleware/file-intake/font-rejection-classifier";
import { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import type { TelegramFileDownloader } from "app/telegram/file-downloader/telegram-file-downloader";
import type { Locale } from "app/telegram/locale/locale.types";
import type { HandlerRun } from "test/telegram/handler.helper";
import { runHandler, supportedFormats } from "test/telegram/handler.helper";
import { realFontValidatorResolver } from "test/font-convertor/convertor-factory.helper";
import { ReadFailed } from "app/shared/fs/file-helper.errors";
import { TelegramFileTooBig } from "app/telegram/file-downloader/telegram-file-downloader.errors";

const FONTS_DIR = path.join(process.cwd(), "test", "fixtures", "fonts");
const MAX_DOWNLOAD_SIZE_MB = 20;
const MAX_DOWNLOAD_SIZE_BYTES = MAX_DOWNLOAD_SIZE_MB * 1024 * 1024;
// The offset of the length field in the WOFF header: the size of the whole file.
const WOFF_LENGTH_OFFSET = 8;
const MESSAGE_ID = 42;

type FileContent = () => Promise<Uint8Array | undefined>;

// A download that leaves no file at the path it gives.
const MISSING_FILE: FileContent = async () => undefined;

// getFile refuses the file for its size.
const TOO_BIG_FILE: FileContent = async () => {
    throw TelegramFileTooBig.byFileId("file-id", new Error("Bad Request: file is too big"));
};

// Stands for Telegram: hands out the content the spec gives as a file of the temporary directory.
class FakeFileDownloader {
    public readonly downloadedPaths: string[] = [];

    public constructor(private readonly tempDir: string, private readonly content: FileContent) {}

    public async download(_api: unknown, _fileId: string, extension: Extension): Promise<string> {
        const downloadedPath = path.join(this.tempDir, `${this.downloadedPaths.length}.${extension}`);
        const fileContent = await this.content();

        if (fileContent !== undefined) {
            await fs.writeFile(downloadedPath, fileContent);
        }

        this.downloadedPaths.push(downloadedPath);

        return downloadedPath;
    }
}

function fixture(name: string): FileContent {
    return async () => new Uint8Array(await fs.readFile(path.join(FONTS_DIR, name)));
}

function document(fields: Partial<Document>): Partial<Message> {
    return { message_id: MESSAGE_ID, document: { file_id: "file-id", file_unique_id: "file-unique-id", ...fields } };
}

describe("FileIntakeMiddleware", function () {
    let tempDir: string;

    beforeEach(async function () {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-intake-middleware-"));
    });

    afterEach(async function () {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function run(
        content: Partial<Message>,
        fileContent: FileContent = fixture("test-font.woff"),
        locale?: Locale,
    ): Promise<HandlerRun & { downloader: FakeFileDownloader }> {
        const downloader = new FakeFileDownloader(tempDir, fileContent);
        const middleware = new FileIntakeMiddleware(
            supportedFormats,
            new FormatButtons(supportedFormats),
            downloader as unknown as TelegramFileDownloader,
            realFontValidatorResolver(),
            new FontRejectionClassifier(),
            MAX_DOWNLOAD_SIZE_MB,
        );

        return { ...(await runHandler(middleware, content, locale)), downloader: downloader };
    }

    it("asks what to convert a font into, in reply to its message, with the format buttons", async function () {
        const { replies, replyOptions, isPassedOn } = await run(document({ file_name: "MyFont.woff" }));

        expect(replies).to.deep.equal(["Это WOFF. Во что сконвертировать?"]);
        expect(replyOptions[0]?.reply_parameters).to.deep.equal({ message_id: MESSAGE_ID, allow_sending_without_reply: true });
        expect(
            (replyOptions[0]?.reply_markup as InlineKeyboard).inline_keyboard.map((row) => row.map((button) => button.text)),
        ).to.deep.equal([["TTF", "OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
        expect(isPassedOn).to.equal(false);
    });

    it("asks in the locale of the update", async function () {
        const { replies } = await run(document({ file_name: "MyFont.woff" }), fixture("test-font.woff"), "en");

        expect(replies).to.deep.equal(["This is WOFF. What should I convert it into?"]);
    });

    it("takes the extension in any case", async function () {
        const { replies } = await run(document({ file_name: "MyFont.TTF" }), fixture("test-font.ttf"));

        expect(replies).to.deep.equal(["Это TTF. Во что сконвертировать?"]);
    });

    it("removes the downloaded file after the check", async function () {
        const { downloader } = await run(document({ file_name: "MyFont.woff" }));

        expect(downloader.downloadedPaths).to.have.lengthOf(1);
        expect(await fs.readdir(tempDir)).to.deep.equal([]);
    });

    it("refuses a file over the size limit without downloading it", async function () {
        const { replies, downloader } = await run(document({ file_name: "MyFont.woff", file_size: MAX_DOWNLOAD_SIZE_BYTES + 1 }));

        expect(replies).to.deep.equal(["Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы."]);
        expect(downloader.downloadedPaths).to.deep.equal([]);
    });

    it("takes a file of the size limit", async function () {
        const { replies } = await run(document({ file_name: "MyFont.woff", file_size: MAX_DOWNLOAD_SIZE_BYTES }));

        expect(replies).to.deep.equal(["Это WOFF. Во что сконвертировать?"]);
    });

    // A document without a size, or a limit above the one of getFile.
    it("refuses a file getFile refuses for its size", async function () {
        const { replies } = await run(document({ file_name: "MyFont.woff" }), TOO_BIG_FILE);

        expect(replies).to.deep.equal(["Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы."]);
    });

    // The size goes first: a file over the limit cannot be downloaded whatever its name.
    it("refuses a file over the size limit before it looks at the extension", async function () {
        const { replies } = await run(document({ file_name: "notes.pdf", file_size: MAX_DOWNLOAD_SIZE_BYTES + 1 }));

        expect(replies).to.deep.equal(["Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы."]);
    });

    for (const fileName of ["notes.pdf", "MyFont", ".woff"]) {
        it(`refuses "${fileName}" by its name without downloading it`, async function () {
            const { replies, downloader } = await run(document({ file_name: fileName }));

            expect(replies).to.deep.equal([
                `«${fileName}» — не шрифт или формат, который я не знаю. Поддерживаю: TTF, OTF, WOFF, WOFF2, EOT, SVG.`,
            ]);
            expect(downloader.downloadedPaths).to.deep.equal([]);
        });
    }

    it("refuses a file without a name", async function () {
        const { replies } = await run(document({}));

        expect(replies).to.deep.equal(["Файл — не шрифт или формат, который я не знаю. Поддерживаю: TTF, OTF, WOFF, WOFF2, EOT, SVG."]);
    });

    it("tells a file whose content is not in the format of its extension", async function () {
        const { replies } = await run(document({ file_name: "MyFont.woff" }), fixture("test-font.ttf"));

        expect(replies).to.deep.equal(["Файл назван как WOFF, но внутри не WOFF. Возможно, у него не то расширение."]);
    });

    it("tells an SVG drawing with no font for a file not in the format", async function () {
        const drawing = async (): Promise<Uint8Array> =>
            new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
        const { replies } = await run(document({ file_name: "logo.svg" }), drawing);

        expect(replies).to.deep.equal(["Файл назван как SVG, но внутри не SVG. Возможно, у него не то расширение."]);
    });

    it("tells a broken font of the format", async function () {
        const brokenWoff = async (): Promise<Uint8Array> => {
            const content = new Uint8Array(await fs.readFile(path.join(FONTS_DIR, "test-font.woff")));
            new DataView(content.buffer, content.byteOffset).setUint32(WOFF_LENGTH_OFFSET, content.byteLength + 1);

            return content;
        };
        const { replies, downloader } = await run(document({ file_name: "MyFont.woff" }), brokenWoff);

        expect(replies).to.deep.equal(["Файл похож на WOFF, но повреждён. Попробуйте скачать шрифт заново из источника."]);
        expect(downloader.downloadedPaths).to.have.lengthOf(1);
        expect(await fs.readdir(tempDir)).to.deep.equal([]);
    });

    it("tells the refusals in the locale of the update", async function () {
        const { replies } = await run(document({ file_name: "MyFont.woff" }), fixture("test-font.ttf"), "en");

        expect(replies).to.deep.equal(["The file is named as WOFF, but it is not WOFF inside. Perhaps its extension is wrong."]);
    });

    // The inbox picks the outcome of the update by the error (docs/architecture/inbox.md, "Failures").
    it("lets an error that is no refusal of the file through", async function () {
        const error = await run(document({ file_name: "MyFont.woff" }), MISSING_FILE).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(ReadFailed);
    });

    it("passes a message without a document on", async function () {
        const { replies, isPassedOn } = await run({ text: "hello" });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });
});
