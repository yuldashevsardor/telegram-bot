import { constants as httpStatus } from "node:http2";
import { GrammyError, HttpError } from "grammy";
import { injectable } from "inversify";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { TelegramBotApiFailure } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";

// The error_code of the Bot API repeats the HTTP status of its answer, so Node's HTTP status
// constants name it. They stop at 511 and have no name for the end of the 5xx range.
const LAST_SERVER_ERROR_STATUS = 599;

const CHAT_NOT_FOUND_DESCRIPTION = "Bad Request: chat not found";

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

        if (error.error_code === httpStatus.HTTP_STATUS_BAD_REQUEST && error.description === CHAT_NOT_FOUND_DESCRIPTION) {
            return { kind: TelegramBotApiFailureKind.Undeliverable };
        }

        return { kind: TelegramBotApiFailureKind.Unexpected };
    }
}
