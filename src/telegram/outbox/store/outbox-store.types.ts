import type postgres from "postgres";
import type { ErrorObject } from "serialize-error";
import type { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";

// The values of telegram_outbox.status: the database does not check them, so they are written only
// through this enum.
export enum OutboxStatus {
    Pending = "pending",
    Processing = "processing",
    Done = "done",
    Failed = "failed",
    Skipped = "skipped",
}

// The values of telegram_outbox_chats.state, written only through this enum as well.
export enum OutboxChatState {
    // No active message.
    Idle = "idle",
    // The head is pending and can be pulled.
    Ready = "ready",
    // The head is pulled.
    Processing = "processing",
    // A failed message stopped the chat until it is unblocked by hand.
    Blocked = "blocked",
}

// Only what survives JSON goes into a jsonb column: the driver serializes the value itself.
export type OutboxJson = postgres.JSONValue;

export type OutboxPayload = { readonly [key: string]: OutboxJson };

// A Bot API call to push. A lower priority goes first.
export type OutboxMessageInput = {
    chatId: number;
    method: string;
    payload: OutboxPayload;
    priority: number;
};

// Who pulled a message, written into its attempt: the node and the worker on it.
export type OutboxWorker = {
    host: string;
    pid: number;
    workerId: string;
};

// The error an attempt is closed with: the caught error serialized whole, as the logger writes it
// (serializeError), and its class. The class decides whether the attempt counts towards the limit.
export type OutboxAttemptError = ErrorObject & { kind: TelegramBotApiFailureKind };

// One attempt of a message, as telegram_outbox.attempts keeps it. The pull opens it; a completion
// closes it with finished_at and error, null for a success.
export type OutboxAttempt = {
    started_at: string;
    worker: { host: string; pid: number; worker_id: string };
    finished_at: string | null;
    error: OutboxAttemptError | null;
};

// What a completion of a pulled message is fenced by: the message and the token of the pull that
// leased its chat. The attempts are those the pull returned: while the lease holds, nothing else
// writes them. A pulled message is a lease itself.
export type OutboxLease = {
    id: number;
    lockToken: string;
    attempts: OutboxAttempt[];
};

export type PulledOutboxMessage = OutboxMessageInput & OutboxLease;

// What a pull gives out: the messages, and when the next pull can give out one.
export type OutboxPullResult = {
    messages: PulledOutboxMessage[];
    // Counted by the database clock from the pull. null: no chat is ready, so only a push or a
    // completion brings a message.
    nextPullInMs: number | null;
};

// How a message leaves the outbox: sent with Telegram's response, or failed with the error of its
// last attempt.
export type OutboxFinalOutcome =
    | { status: OutboxStatus.Done; attemptError: null; response: OutboxJson }
    | { status: OutboxStatus.Failed; attemptError: OutboxAttemptError; response: null };

// A pulled row as the pull returns it inside jsonb, where a bigint is a number, not a string.
export type PulledOutboxRow = {
    id: number;
    chat_id: number;
    method: string;
    payload: OutboxPayload;
    priority: number;
    attempts: OutboxAttempt[];
};

// The single row of a pull as postgres returns it.
export type OutboxPullResultRow = {
    messages: PulledOutboxRow[];
    next_pull_in_ms: number | null;
    has_bot_limits: boolean;
};
