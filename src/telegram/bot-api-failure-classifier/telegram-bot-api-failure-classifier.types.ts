// The classes of a failed Bot API call. What happens to the call in each is decided by the caller.
export enum TelegramBotApiFailureKind {
    // Telegram or the way to it failed for a while: the same call may pass later.
    Transient = "transient",
    // A 429: Telegram asks to wait retryAfterSeconds before the next call.
    Flood = "flood",
    // The chat cannot get the message at all: a retry would fail the same way.
    Undeliverable = "undeliverable",
    // Anything else, a bug included: nothing says a retry would help.
    Unexpected = "unexpected",
}

export type TelegramBotApiFailure =
    | { kind: TelegramBotApiFailureKind.Flood; retryAfterSeconds: number }
    | { kind: Exclude<TelegramBotApiFailureKind, TelegramBotApiFailureKind.Flood> };
