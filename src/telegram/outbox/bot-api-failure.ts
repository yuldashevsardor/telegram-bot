import { GrammyError, HttpError } from "grammy";

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;
const LAST_SERVER_ERROR = 599;

const CHAT_NOT_FOUND_DESCRIPTION = "Bad Request: chat not found";

// The shape of parameters comes from the answer, not from the type, so retry_after is parsed
// without relying on it.
function readRetryAfterSeconds(error: GrammyError): number {
    const retryAfterSeconds = Number(error.parameters.retry_after);

    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
        return DEFAULT_RETRY_AFTER_SECONDS;
    }

    return retryAfterSeconds;
}

// The Bot API always sends retry_after with a 429. If it is missing or unreadable, the pause must
// still be non-zero, or the outbox would retry at once and run into the same 429. The outbound
// queue has a constant of the same name and parses retry_after the same way; the outbox keeps its
// own because it replaces that queue, and the queue's copy goes with it.
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

// The classes of a failed Bot API call. What the outbox does with each is decided by its caller.
export enum BotApiFailureKind {
    // A network error or a Telegram 5xx: the same call may pass later.
    Transient = "transient",
    // A 429: the whole outbox waits retryAfterSeconds.
    Flood = "flood",
    // The chat cannot get the message at all: a 403, or a 400 "chat not found".
    Undeliverable = "undeliverable",
    // Anything else: a bug, an unexpected 4xx, an error that is not grammY's.
    Unexpected = "unexpected",
}

export type BotApiFailure =
    | { kind: BotApiFailureKind.Flood; retryAfterSeconds: number }
    | { kind: Exclude<BotApiFailureKind, BotApiFailureKind.Flood> };

// grammY throws an HttpError when the request does not reach Telegram or its answer does not come
// back, and a GrammyError when Telegram answers ok: false.
export function classifyBotApiFailure(error: unknown): BotApiFailure {
    if (error instanceof HttpError) {
        return { kind: BotApiFailureKind.Transient };
    }

    if (!(error instanceof GrammyError)) {
        return { kind: BotApiFailureKind.Unexpected };
    }

    if (error.error_code === TOO_MANY_REQUESTS) {
        return { kind: BotApiFailureKind.Flood, retryAfterSeconds: readRetryAfterSeconds(error) };
    }

    if (error.error_code >= FIRST_SERVER_ERROR && error.error_code <= LAST_SERVER_ERROR) {
        return { kind: BotApiFailureKind.Transient };
    }

    if (error.error_code === FORBIDDEN) {
        return { kind: BotApiFailureKind.Undeliverable };
    }

    if (error.error_code === BAD_REQUEST && error.description === CHAT_NOT_FOUND_DESCRIPTION) {
        return { kind: BotApiFailureKind.Undeliverable };
    }

    return { kind: BotApiFailureKind.Unexpected };
}
