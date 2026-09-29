import type postgres from "postgres";

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
export type FinishedOutboxStatus = OutboxStatus.Done | OutboxStatus.Failed | OutboxStatus.Skipped;

// The PostgreSQL channels of the outbox. The payload of a Finished notification is the message id
// alone: NOTIFY carries at most 8000 bytes, less than a Telegram response can take.
export enum OutboxChannel {
    // A push: an idle sender can pull.
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
    // The head failed.
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

export type PulledOutboxMessage = OutboxMessageInput & {
    id: number;
};

// What a pull gives out: the messages, and when the next pull can give out one.
export type OutboxPullResult = {
    messages: PulledOutboxMessage[];
    // Counted by the database clock from the pull. null: no chat is ready, so only a push or a
    // completion brings a message.
    nextPullInMs: number | null;
};

// A pulled row as the pull returns it inside jsonb, where a bigint is a number, not a string.
export type PulledOutboxRow = {
    id: number;
    chat_id: number;
    method: string;
    payload: OutboxPayload;
    priority: number;
};

// The single row of a pull as postgres returns it.
export type OutboxPullResultRow = {
    messages: PulledOutboxRow[];
    next_pull_in_ms: number | null;
};

// A message in a final status, as the caller waiting for it gets it.
export type FinishedOutboxMessage = {
    id: number;
    status: FinishedOutboxStatus;
    response: OutboxJson | null;
};

// A finished message as postgres returns it: a bigint comes as a string.
export type FinishedOutboxRow = {
    id: string;
    status: FinishedOutboxStatus;
    response: OutboxJson | null;
};
