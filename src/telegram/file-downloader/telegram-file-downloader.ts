import path from "path";
import type { Api } from "grammy";
import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";
import { FileHelper } from "app/shared/fs/file-helper";
import { StringHelper } from "app/shared/string/string-helper";
import { MS_PER_SECOND } from "app/shared/time";
import type { Extension } from "app/font-convertor/font-convertor.types";
import { TelegramFileNotDownloaded } from "app/telegram/file-downloader/telegram-file-downloader.errors";

// The Bot API has no method that gives the bytes of a file: getFile gives a path, and the file is
// downloaded from that path past the methods, by plain HTTP.
@injectable()
export class TelegramFileDownloader {
    // grammY's default apiRoot: a file lies under it as well as the methods.
    public static readonly API_ROOT = "https://api.telegram.org";

    // A download stuck on a dead connection would hold the update, and the inbox would keep
    // extending its lease (docs/architecture/inbox.md, "The update processor").
    private static readonly DOWNLOAD_TIMEOUT_MS = 60 * MS_PER_SECOND;
    private static readonly FILENAME_LENGTH = 15;

    public constructor(
        private readonly botToken: string = configValue("bot.token"),
        private readonly tempDir: string = configValue("tempDir"),
        private readonly apiRoot: string = TelegramFileDownloader.API_ROOT,
    ) {}

    /**
     * Downloads the file into the temporary directory under a random name with `extension` and
     * returns its path. The caller removes the file.
     */
    public async download(api: Api, fileId: string, extension: Extension): Promise<string> {
        const telegramFile = await api.getFile(fileId);

        if (telegramFile.file_path === undefined) {
            throw TelegramFileNotDownloaded.withoutPath(fileId);
        }

        const response = await fetch(`${this.apiRoot}/file/bot${this.botToken}/${telegramFile.file_path}`, {
            signal: AbortSignal.timeout(TelegramFileDownloader.DOWNLOAD_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw TelegramFileNotDownloaded.byStatus(fileId, response.status);
        }

        const filename = StringHelper.generateRandomString(TelegramFileDownloader.FILENAME_LENGTH).toLowerCase() + "." + extension;
        const downloadedFilePath = path.join(await FileHelper.createDirectoriesByDate(this.tempDir), filename);

        await FileHelper.write(downloadedFilePath, new Uint8Array(await response.arrayBuffer()));

        return downloadedFilePath;
    }
}
