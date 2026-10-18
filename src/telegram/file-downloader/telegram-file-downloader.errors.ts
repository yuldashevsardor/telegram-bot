import { RuntimeError } from "app/shared/errors";

/**
 * The download of a file failed on the way: the inbox takes it for a transient failure, and the
 * retry of the update asks getFile for the path again.
 */
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

    // getFile answers so a file Telegram cannot give right now, and the same call may pass later.
    public static byGetFileError(fileId: string, error: Error): TelegramFileNotDownloaded {
        return new TelegramFileNotDownloaded("Telegram cannot give the file right now.", { fileId: fileId, cause: error });
    }

    // A failure of fetch itself: the network, or the timeout of the download.
    public static byFetchError(fileId: string, error: unknown): TelegramFileNotDownloaded {
        return new TelegramFileNotDownloaded("The download of the file failed.", { fileId: fileId, cause: error });
    }
}

/**
 * getFile refused the file for its size: the message reported none, or a larger one than the limit
 * of the bot lets through.
 */
export class TelegramFileTooBig extends RuntimeError {
    public static byFileId(fileId: string, error: Error): TelegramFileTooBig {
        return new TelegramFileTooBig("Telegram refused to give the file: it is too big.", { fileId: fileId, cause: error });
    }
}
