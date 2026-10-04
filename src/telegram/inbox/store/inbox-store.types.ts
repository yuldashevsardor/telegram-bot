import type { Update } from "@grammyjs/types";
import type { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import type { OutboxJsonObject } from "app/telegram/outbox/store/outbox-store.types";

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

// The notification channels of the inbox.
export enum InboxChannel {
    // A push or a completion that leaves its group ready: an idle worker can claim.
    Ready = "telegram_inbox_ready",
}

// An update to store, with its group: the user and the chat of the session key. An update without
// either is not stored (docs/architecture/inbox.md, "Updates without a session key").
export type InboxUpdateInput = {
    userId: number;
    chatId: number;
    update: Update;
};

// The key of a group: the user and the chat of the session key.
export type InboxGroupKey = {
    userId: number;
    chatId: number;
};

// Who claimed an update, written into its attempt: the node and its worker loop. workerId names the
// loop, not one of its slots.
export type InboxWorker = {
    host: string;
    pid: number;
    workerId: string;
};

// The error an attempt ends with: the caught error as OutboxErrorSerializer writes it, and its class.
export type InboxAttemptError = OutboxJsonObject & { kind: InboxFailureKind };

// One attempt of an update, as telegram_inbox.attempts keeps it: a completion appends it whole,
// finished_at is set by the database. error is null for a success. worker is null for the attempt
// of an expired lease: the worker of its claim is stored nowhere.
export type InboxAttempt = {
    started_at: string;
    worker: { host: string; pid: number; worker_id: string } | null;
    finished_at: string;
    error: InboxAttemptError | null;
};

// What a completion of a claimed update is fenced by: the update and the token of the claim that
// leased its group. The start of the attempt and its worker go with it: the completion writes the
// attempt. A claimed update is a lease itself, and so is an expired lease the recovery reads.
export type InboxLease = {
    updateId: number;
    lockToken: string;
    // The time of the claim by the database clock; derived for an expired lease (ExpiredInboxLease).
    startedAt: string;
    // null for an expired lease.
    worker: InboxWorker | null;
};

export type ClaimedInboxUpdate = InboxUpdateInput &
    InboxLease & {
        worker: InboxWorker;
        // The attempts the update has made before this one, whatever they ended with.
        earlierAttempts: number;
    };

// A lease that passed before its update was completed: the node that claimed the update is presumed
// dead. startedAt is updated_at of the processing update, which only the claim writes.
export type ExpiredInboxLease = InboxLease & {
    worker: null;
    earlierAttempts: number;
};

// A claimed row as postgres returns it: a bigint comes as a string.
export type ClaimedInboxRow = {
    update_id: string;
    user_id: string;
    chat_id: string;
    update: Update;
    started_at: string;
    earlier_attempts: number;
};

// An expired lease as postgres returns it.
export type ExpiredInboxLeaseRow = {
    update_id: string;
    lock_token: string;
    started_at: string;
    earlier_attempts: number;
};

// The group row a completion locks, as postgres returns it.
export type LockedInboxGroupRow = {
    user_id: string;
    chat_id: string;
    lock_token: string | null;
};

export type InboxCleanupSettings = {
    // How long a done update is kept after its end. Telegram redelivers an update within 24 h, and
    // the row of the update is what turns the redelivery away.
    doneRetentionMs: number;
    // How long a skipped update is kept after its end.
    skippedRetentionMs: number;
    // The most rows one call of the cleanup deletes.
    batchSize: number;
};
