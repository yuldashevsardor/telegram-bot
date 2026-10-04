import type postgres from "postgres";
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

// The statuses that give the caller of a message its outcome and end its wait. A failed message
// may still be retried by hand later, but its caller has had its answer.
export const FINISHED_STATUSES = [OutboxStatus.Done, OutboxStatus.Failed, OutboxStatus.Skipped] as const;

export type FinishedOutboxStatus = (typeof FINISHED_STATUSES)[number];

// The PostgreSQL channels of the outbox. The payload of a Finished notification is the message id
// alone: NOTIFY carries at most 8000 bytes, less than a Telegram response can take.
export enum OutboxChannel {
    // A push, or a completion that leaves its chat ready: an idle sender can pull.
    Ready = "telegram_outbox_ready",
    // A message reached a final status.
    Finished = "telegram_outbox_finished",
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

// The priorities the callers push with: the head of a chat with calls of the bot API goes before the
// head of a chat with bulk messages. Inside a chat the order is by id, so a reply pushed behind a
// bulk batch of its own chat waits for the batch.
export enum OutboxPriority {
    Call = 100,
    Bulk = 200,
}

// A Bot API call to push. A lower priority goes first, across chats only. The store orders by any
// integer, so priority is a number rather than OutboxPriority: the enum names the values the callers
// use, not all the store takes.
export type OutboxMessageInput = {
    chatId: number;
    method: string;
    payload: OutboxPayload;
    priority: number;
};

// Who pulled a message, written into its attempt: the node and its runner. workerId names the
// loop, not one of its slots.
export type OutboxWorker = {
    host: string;
    pid: number;
    workerId: string;
};

// A JSON object, as a jsonb column takes it.
export type OutboxJsonObject = { [field: string]: OutboxJson };

// The error an attempt ends with: the caught error as OutboxErrorSerializer writes it, and its class.
export type OutboxAttemptError = OutboxJsonObject & { kind: TelegramBotApiFailureKind };

// One attempt of a message, as telegram_outbox.attempts keeps it: a completion appends it whole,
// finished_at is set by the database. error is null for a success. worker is null for the attempt
// of an expired lease: the worker of its pull is stored nowhere.
export type OutboxAttempt = {
    started_at: string;
    worker: { host: string; pid: number; worker_id: string } | null;
    finished_at: string;
    error: OutboxAttemptError | null;
};

// What a completion of a leased message is fenced by: the message and the token of the pull that
// leased its chat. The start of the attempt and its worker go with it: the completion writes the
// attempt. A pulled message is a lease itself, and so is an expired lease the recovery reads.
export type OutboxLease = {
    id: number;
    lockToken: string;
    // The time of the pull, the moment it held the bot row, by the database clock; derived for an
    // expired lease (ExpiredOutboxLease).
    startedAt: string;
    // null for an expired lease.
    worker: OutboxWorker | null;
};

export type PulledOutboxMessage = OutboxMessageInput &
    OutboxLease & {
        worker: OutboxWorker;
        // The attempts the message has made before this one, whatever they ended with.
        earlierAttempts: number;
    };

// A lease that passed before its message was completed: the node that pulled the message is
// presumed dead. Only the lease end is stored, so startedAt is that end minus the lease duration.
export type ExpiredOutboxLease = OutboxLease & {
    worker: null;
    earlierAttempts: number;
};

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
    started_at: string;
    earlier_attempts: number;
};

// An expired lease as postgres returns it: a bigint comes as a string.
export type ExpiredOutboxLeaseRow = {
    id: string;
    lock_token: string;
    started_at: string;
    earlier_attempts: number;
};

// The single row of a pull as postgres returns it.
export type OutboxPullResultRow = {
    messages: PulledOutboxRow[];
    next_pull_in_ms: number | null;
    has_bot_limits: boolean;
};

// What the cleanup deletes and how much at a time. A failed message has no retention: it is never
// deleted automatically.
export type OutboxCleanupSettings = {
    // How long a done message is kept after its end.
    doneRetentionMs: number;
    // How long a skipped message is kept after its end.
    skippedRetentionMs: number;
    // The most rows one call of the cleanup deletes.
    batchSize: number;
};

// A message in a final status, as the caller waiting for it gets it.
export type FinishedOutboxMessage = {
    id: number;
    status: FinishedOutboxStatus;
    response: OutboxJson | null;
    // The error of the last attempt: what a failed message failed with. null when the last attempt
    // succeeded or there was none.
    error: OutboxAttemptError | null;
};

// A finished message as postgres returns it: a bigint comes as a string.
export type FinishedOutboxRow = {
    id: string;
    status: FinishedOutboxStatus;
    response: OutboxJson | null;
    error: OutboxAttemptError | null;
};
