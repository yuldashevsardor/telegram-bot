import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Api, GrammyError } from "grammy";
import type { RawApi, Transformer } from "grammy";
import type { ApiResponse } from "@grammyjs/types";
import { Extension } from "app/font-convertor/font-convertor.types";
import { TelegramFileDownloader } from "app/telegram/file-downloader/telegram-file-downloader";
import { TelegramFileNotDownloaded, TelegramFileTooBig } from "app/telegram/file-downloader/telegram-file-downloader.errors";
import { FakeBotApi } from "test/telegram/fake-bot-api.helper";

const TOKEN = "123:downloader";
const FILE_ID = "file-id";
const FILE_PATH = "documents/file_7.ttf";
const CONTENT = new Uint8Array([0, 1, 0, 0, 255]);

describe("TelegramFileDownloader", function () {
    let fakeBotApi: FakeBotApi;
    let api: Api;
    let downloader: TelegramFileDownloader;
    let tempDir: string;

    beforeEach(async function () {
        fakeBotApi = new FakeBotApi();
        const apiRoot = await fakeBotApi.start();
        api = new Api(TOKEN, { apiRoot: apiRoot });
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-file-downloader-"));
        downloader = new TelegramFileDownloader(tempDir);
    });

    afterEach(async function () {
        await fakeBotApi.close();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function answerGetFile(filePath: string | undefined): void {
        fakeBotApi.answerWith(() => ({ ok: true, result: { file_id: FILE_ID, file_unique_id: "unique", file_path: filePath } }));
    }

    it("downloads the file at the path getFile gives into the temporary directory, with the extension", async function () {
        answerGetFile(FILE_PATH);
        fakeBotApi.serveFile(FILE_PATH, CONTENT);

        const downloadedPath = await downloader.download(api, FILE_ID, Extension.WOFF);

        expect(downloadedPath.startsWith(tempDir + path.sep)).to.equal(true);
        expect(path.extname(downloadedPath)).to.equal(".woff");
        expect(new Uint8Array(await fs.readFile(downloadedPath))).to.deep.equal(CONTENT);
        expect(fakeBotApi.calls.map((call) => [call.method, call.payload])).to.deep.equal([["getFile", { file_id: FILE_ID }]]);
    });

    it("rejects a file getFile gives no path for", async function () {
        answerGetFile(undefined);

        const error = await downloader.download(api, FILE_ID, Extension.TTF).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(TelegramFileNotDownloaded).with.deep.property("payload", { fileId: FILE_ID });
    });

    it("rejects a download Telegram does not answer with the file", async function () {
        answerGetFile(FILE_PATH);

        const error = await downloader.download(api, FILE_ID, Extension.TTF).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(TelegramFileNotDownloaded).with.deep.property("payload", { fileId: FILE_ID, status: 404 });
        expect(await fs.readdir(tempDir)).to.deep.equal([]);
    });

    it("rejects a download whose connection fails, with the failure as the cause", async function () {
        // getFile is answered in place, and the root of the Api is a port nothing listens on.
        const unreachableApi = new Api(TOKEN, { apiRoot: "http://127.0.0.1:1" });
        const answerGetFileInPlace: Transformer<RawApi> = async () =>
            ({ ok: true, result: { file_id: FILE_ID, file_unique_id: "unique", file_path: FILE_PATH } } as ApiResponse<never>);
        unreachableApi.config.use(answerGetFileInPlace);

        const error = await downloader.download(unreachableApi, FILE_ID, Extension.TTF).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(TelegramFileNotDownloaded);
        expect((error as Error).cause).to.be.instanceOf(TypeError);
    });

    it("tells a file getFile refuses for its size", async function () {
        fakeBotApi.answerWith(() => ({ ok: false, error_code: 400, description: "Bad Request: file is too big" }));

        const error = await downloader.download(api, FILE_ID, Extension.TTF).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(TelegramFileTooBig).with.deep.property("payload", { fileId: FILE_ID });
    });

    it("lets another refusal of getFile through as it is", async function () {
        fakeBotApi.answerWith(() => ({
            ok: false,
            error_code: 400,
            description: "Bad Request: wrong file_id or the file is temporarily unavailable",
        }));

        const error = await downloader.download(api, FILE_ID, Extension.TTF).catch((caught: unknown) => caught);

        expect(error).to.be.instanceOf(GrammyError);
    });
});
