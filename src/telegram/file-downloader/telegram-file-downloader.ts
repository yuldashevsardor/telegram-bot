import path from "path";
import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { File } from "@grammyjs/types";
import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";
import { FileHelper } from "app/shared/fs/file-helper";
import { StringHelper } from "app/shared/string/string-helper";
import { MS_PER_SECOND } from "app/shared/time";
import type { Extension } from "app/font-convertor/font-convertor.types";
import { TelegramFileNotDownloaded, TelegramFileTooBig } from "app/telegram/file-downloader/telegram-file-downloader.errors";

// The Bot API has no method that gives the bytes of a file: getFile gives a path, and the file is
// downloaded from that path past the methods, by plain HTTP.
@injectable()
export class TelegramFileDownloader {
    // grammY's default apiRoot, for an Api built without one: a file lies under the same root as
    // the methods.
    private static readonly DEFAULT_API_ROOT = "https://api.telegram.org";

    // A download stuck on a dead connection would hold the update, and the inbox would keep
    // extending its lease (docs/architecture/inbox.md, "The update processor").
    private static readonly DOWNLOAD_TIMEOUT_MS = 60 * MS_PER_SECOND;
    private static readonly FILENAME_LENGTH_CHARS = 15;

    // How the Bot API describes a file over the limit of getFile.
    private static readonly FILE_TOO_BIG_DESCRIPTION = "file is too big";
    private static readonly BAD_REQUEST_CODE = 400;

    public constructor(private readonly tempDir: string = configValue("tempDir")) {}

    /**
     * Downloads the file into the temporary directory under a random name with `extension` and
     * returns its path. The caller removes the file. Throws `TelegramFileTooBig` when getFile refuses
     * the file for its size.
     */
    public async download(api: Api, fileId: string, extension: Extension): Promise<string> {
        const telegramFile = await this.getFile(api, fileId);

        if (telegramFile.file_path === undefined) {
            throw TelegramFileNotDownloaded.withoutPath(fileId);
        }

        const content = await this.fetchContent(api, fileId, telegramFile.file_path);
        const filename = StringHelper.generateRandomString(TelegramFileDownloader.FILENAME_LENGTH_CHARS).toLowerCase() + "." + extension;
        const downloadedFilePath = path.join(await FileHelper.createDirectoriesByDate(this.tempDir), filename);

        try {
            await FileHelper.write(downloadedFilePath, content);
        } catch (error) {
            // A write cut short, by a full disk say, leaves a part of the file behind.
            await FileHelper.remove(downloadedFilePath);

            throw error;
        }

        return downloadedFilePath;
    }

    private async getFile(api: Api, fileId: string): Promise<File> {
        try {
            return await api.getFile(fileId);
        } catch (error) {
            if (this.isTooBig(error)) {
                throw TelegramFileTooBig.byFileId(fileId, error);
            }

            throw error;
        }
    }

    private isTooBig(error: unknown): error is GrammyError {
        return (
            error instanceof GrammyError &&
            error.error_code === TelegramFileDownloader.BAD_REQUEST_CODE &&
            error.description.includes(TelegramFileDownloader.FILE_TOO_BIG_DESCRIPTION)
        );
    }

    // The root and the token of the Api getFile went through, so that the path and the file come
    // from the same server.
    private async fetchContent(api: Api, fileId: string, filePath: string): Promise<Uint8Array> {
        const apiRoot = api.options?.apiRoot ?? TelegramFileDownloader.DEFAULT_API_ROOT;
        const signal = AbortSignal.timeout(TelegramFileDownloader.DOWNLOAD_TIMEOUT_MS);
        let response: Response;

        try {
            response = await fetch(`${apiRoot}/file/bot${api.token}/${filePath}`, { signal: signal });
        } catch (error) {
            throw TelegramFileNotDownloaded.byFetchError(fileId, error);
        }

        if (!response.ok) {
            throw TelegramFileNotDownloaded.byStatus(fileId, response.status);
        }

        try {
            return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            throw TelegramFileNotDownloaded.byFetchError(fileId, error);
        }
    }
}
