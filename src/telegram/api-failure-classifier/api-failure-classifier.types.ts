// The classes of a failed Bot API call. What happens to the call in each is decided by the caller.
export enum TelegramBotApiFailureKind {
    // A network error or a Telegram 5xx: the same call may pass later.
    Transient = "transient",
    // A 429: Telegram asks to wait retryAfterSeconds before the next call.
    Flood = "flood",
    // The chat cannot get the message at all: a 403, or a 400 "chat not found".
    Undeliverable = "undeliverable",
    // Anything else: a bug, an unexpected 4xx, an error that is not grammY's.
    Unexpected = "unexpected",
}

export type TelegramBotApiFailure =
    | { kind: TelegramBotApiFailureKind.Flood; retryAfterSeconds: number }
    | { kind: Exclude<TelegramBotApiFailureKind, TelegramBotApiFailureKind.Flood> };
