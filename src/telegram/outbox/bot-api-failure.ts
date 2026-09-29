import { constants as httpStatus } from "node:http2";
import { GrammyError, HttpError } from "grammy";
import { injectable } from "inversify";

// The error_code of the Bot API repeats the HTTP status of its answer, so Node's HTTP status
// constants name it. They stop at 511 and have no name for the end of the 5xx range.
const LAST_SERVER_ERROR = 599;

const CHAT_NOT_FOUND_DESCRIPTION = "Bad Request: chat not found";

// The Bot API always sends retry_after with a 429. If it is missing or unreadable, the pause must
// still be non-zero, or the outbox would retry at once and run into the same 429. The outbound
// queue has a constant of the same name and parses retry_after the same way; the outbox keeps its
// own because it replaces that queue, and the queue's copy goes with it.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

// The classes of a failed Bot API call. What the outbox does with each is decided by its caller.
export enum BotApiFailureKind {
    // A network error or a Telegram 5xx: the same call may pass later.
    Transient = "transient",
    // A 429: Telegram asks to wait retryAfterSeconds before the next call.
    Flood = "flood",
    // The chat cannot get the message at all: a 403, or a 400 "chat not found".
    Undeliverable = "undeliverable",
    // Anything else: a bug, an unexpected 4xx, an error that is not grammY's.
    Unexpected = "unexpected",
}

export type BotApiFailure =
    | { kind: BotApiFailureKind.Flood; retryAfterSeconds: number }
    | { kind: Exclude<BotApiFailureKind, BotApiFailureKind.Flood> };

@injectable()
export class BotApiFailureClassifier {
    // grammY throws an HttpError when the request does not reach Telegram or its answer does not
    // come back, and a GrammyError when Telegram answers ok: false.
    public classify(error: unknown): BotApiFailure {
        if (error instanceof HttpError) {
            return { kind: BotApiFailureKind.Transient };
        }

        if (!(error instanceof GrammyError)) {
            return { kind: BotApiFailureKind.Unexpected };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_TOO_MANY_REQUESTS) {
            // The shape of parameters comes from the answer, not from the type, so retry_after is
            // parsed without relying on it.
            const retryAfterSeconds = Number(error.parameters.retry_after);

            if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
                return { kind: BotApiFailureKind.Flood, retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS };
            }

            return { kind: BotApiFailureKind.Flood, retryAfterSeconds };
        }

        if (error.error_code >= httpStatus.HTTP_STATUS_INTERNAL_SERVER_ERROR && error.error_code <= LAST_SERVER_ERROR) {
            return { kind: BotApiFailureKind.Transient };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_FORBIDDEN) {
            return { kind: BotApiFailureKind.Undeliverable };
        }

        if (error.error_code === httpStatus.HTTP_STATUS_BAD_REQUEST && error.description === CHAT_NOT_FOUND_DESCRIPTION) {
            return { kind: BotApiFailureKind.Undeliverable };
        }

        return { kind: BotApiFailureKind.Unexpected };
    }
}
