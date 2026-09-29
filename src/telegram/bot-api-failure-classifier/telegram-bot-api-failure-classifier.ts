import { constants as httpStatus } from "node:http2";
import { GrammyError, HttpError } from "grammy";
import { injectable } from "inversify";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { TelegramBotApiFailure } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";

// The error_code of the Bot API repeats the HTTP status of its answer, so Node's HTTP status
// constants name it. They stop at 511 and have no name for the end of the 5xx range.
const LAST_SERVER_ERROR_STATUS = 599;

// The descriptions of a 400 about a chat the bot cannot reach. A 400 is also the code of a malformed
// call, so the exact description decides (docs/architecture/outbox.md, "Error classes").
const UNREACHABLE_CHAT_DESCRIPTIONS: ReadonlySet<string> = new Set([
    "Bad Request: chat not found",
    "Bad Request: PEER_ID_INVALID",
    "Bad Request: user not found",
]);

// The Bot API always sends retry_after with a 429. If it is missing or unreadable, the pause must
// still be non-zero, or the caller would retry at once and run into the same 429. The outbound
// queue has a constant of the same name and parses retry_after the same way; the classifier keeps
// its own because its consumer, the outbox, replaces that queue, and the queue's copy goes with it.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

@injectable()
export class TelegramBotApiFailureClassifier {
    // grammY throws an HttpError when the request does not reach Telegram or its answer does not
    // come back, and a GrammyError when Telegram answers ok: false.
    public classify(error: unknown): TelegramBotApiFailure {
        if (error instanceof HttpError) {
            // A retry reads the same missing file: no backoff helps it.
            if (this.isFileSystemError(error.error)) {
                return { kind: TelegramBotApiFailureKind.Unexpected };
            }

            return { kind: TelegramBotApiFailureKind.Transient };
        }

        if (!(error instanceof GrammyError)) {
            return { kind: TelegramBotApiFailureKind.Unexpected };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_TOO_MANY_REQUESTS) {
            // The shape of parameters comes from the answer, not from the type, so retry_after is
            // parsed without relying on it.
            const retryAfterSeconds = Number(error.parameters.retry_after);

            if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
                return { kind: TelegramBotApiFailureKind.Flood, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
            }

            return { kind: TelegramBotApiFailureKind.Flood, retryAfterSeconds };
        }

        if (error.error_code >= httpStatus.HTTP_STATUS_INTERNAL_SERVER_ERROR && error.error_code <= LAST_SERVER_ERROR_STATUS) {
            return { kind: TelegramBotApiFailureKind.Transient };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_FORBIDDEN) {
            return { kind: TelegramBotApiFailureKind.Undeliverable };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_BAD_REQUEST && this.isUnreachableChat(error)) {
            return { kind: TelegramBotApiFailureKind.Undeliverable };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_UNAUTHORIZED) {
            return { kind: TelegramBotApiFailureKind.Unauthorized };
        }

        return { kind: TelegramBotApiFailureKind.Unexpected };
    }

    // A group upgraded to a supergroup answers with the id of the supergroup in migrate_to_chat_id:
    // the old id takes no messages any more, and the message is not resent to the new one.
    private isUnreachableChat(error: GrammyError): boolean {
        return error.parameters.migrate_to_chat_id !== undefined || UNREACHABLE_CHAT_DESCRIPTIONS.has(error.description);
    }

    // A Node file-system error names the file it failed on: the file of a PathFile is gone or not
    // readable. grammY passes the error of the file stream on as it is, while node-fetch wraps a
    // network error into its FetchError without the path, and the timeout of grammY is a bare Error.
    private isFileSystemError(cause: unknown): boolean {
        return typeof cause === "object" && cause !== null && "path" in cause && typeof cause.path === "string";
    }
}
