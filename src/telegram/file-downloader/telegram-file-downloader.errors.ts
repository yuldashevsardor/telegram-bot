import { RuntimeError } from "app/shared/errors";

export class TelegramFileNotDownloaded extends RuntimeError {
    // getFile answers without a path when the file cannot be downloaded right now; the Bot API
    // promises nothing more about it.
    public static withoutPath(fileId: string): TelegramFileNotDownloaded {
        return new TelegramFileNotDownloaded("Telegram gave no path to download the file.", { fileId: fileId });
    }

    public static byStatus(fileId: string, status: number): TelegramFileNotDownloaded {
        return new TelegramFileNotDownloaded(`Telegram answered the download of the file with HTTP ${status}.`, {
            fileId: fileId,
            status: status,
        });
    }
}
