import type postgres from "postgres";

// Only what survives JSON goes into a jsonb column: the driver serializes the value itself.
export type OutboxJson = postgres.JSONValue;

export type OutboxPayload = { readonly [key: string]: OutboxJson };

// A Bot API call to enqueue. A lower priority goes first.
export type OutboxMessageInput = {
    chatId: number;
    method: string;
    payload: OutboxPayload;
    priority: number;
};

export type ClaimedOutboxMessage = OutboxMessageInput & {
    id: number;
};

// A claimed row as postgres returns it: without a types setting bigint comes back as a string.
export type ClaimedOutboxRow = {
    id: string;
    chat_id: string;
    method: string;
    payload: OutboxPayload;
    priority: number;
};
