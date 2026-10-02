import type { Update } from "@grammyjs/types";

// The values of telegram_inbox.status: the database does not check them, so they are written only
// through this enum.
export enum InboxStatus {
    Pending = "pending",
    Processing = "processing",
    Done = "done",
    Failed = "failed",
    Skipped = "skipped",
}

// The values of telegram_inbox_groups.state, written only through this enum as well.
export enum InboxGroupState {
    // No active update.
    Idle = "idle",
    // The head is pending and can be claimed.
    Ready = "ready",
    // The head is claimed.
    Processing = "processing",
    // A failed update stopped the group until it is unblocked by hand.
    Blocked = "blocked",
}

// An update to store, with its group: the user and the chat of the session key. An update without
// either is not stored (docs/architecture/inbox.md, "Updates without a session key").
export type InboxUpdateInput = {
    userId: number;
    chatId: number;
    update: Update;
};

// What a completion of a claimed update is fenced by: the update and the token of the claim that
// leased its group.
export type InboxLease = {
    updateId: number;
    lockToken: string;
};

export type ClaimedInboxUpdate = InboxUpdateInput & InboxLease;

// A claimed row as postgres returns it: a bigint comes as a string.
export type ClaimedInboxRow = {
    update_id: string;
    user_id: string;
    chat_id: string;
    update: Update;
};

// The group row a completion locks, as postgres returns it.
export type LockedInboxGroupRow = {
    user_id: string;
    chat_id: string;
    lock_token: string | null;
};
