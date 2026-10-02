import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The inbox of Telegram updates: the tables and the columns of all its stages at once, so that the
// later stages need no migration of their own (docs/architecture/inbox.md).

const inbox = "telegram_inbox";
const groups = "telegram_inbox_groups";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable(inbox, {
        update_id: {
            type: "bigint",
            primaryKey: true,
            comment: "Telegram's update_id: a redelivered update is not inserted twice; the order inside a group",
        },
        user_id: {
            type: "bigint",
            notNull: true,
            comment: "The group, with chat_id: the session key",
        },
        chat_id: {
            type: "bigint",
            notNull: true,
            comment: "The group, with user_id: the session key",
        },
        update: {
            type: "jsonb",
            notNull: true,
            comment: "The Update object as Telegram sent it",
        },
        status: {
            type: "text",
            notNull: true,
            comment: "InboxStatus: pending -> processing -> done / failed / skipped",
        },
        attempts: {
            type: "jsonb",
            notNull: true,
            default: pgm.func("'[]'::jsonb"),
            comment: "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}",
        },
        created_at: {
            type: "createdAt",
        },
        updated_at: {
            type: "updatedAt",
        },
        finished_at: {
            type: "timestamptz",
            notNull: false,
            comment: "The final outcome, for the cleanup",
        },
    });

    pgm.createTable(groups, {
        user_id: {
            type: "bigint",
            primaryKey: true,
            comment: "The group, with chat_id; its row is the lock of the group",
        },
        chat_id: {
            type: "bigint",
            primaryKey: true,
            comment: "The group, with user_id; its row is the lock of the group",
        },
        state: {
            type: "text",
            notNull: true,
            comment: "InboxGroupState: idle, ready, processing, blocked",
        },
        next_attempt_at: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
            comment: "When the group may be claimed next; the claim moves it to now(), so the groups are served in turn",
        },
        locked_until: {
            type: "timestamptz",
            notNull: false,
            comment: "Until when the node that claimed the head of the group holds it",
        },
        lock_token: {
            type: "uuid",
            notNull: false,
            comment: "The token of the current claim: a write of an earlier claim does not match it",
        },
        created_at: {
            type: "createdAt",
        },
        updated_at: {
            type: "updatedAt",
        },
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable(groups);
    pgm.dropTable(inbox);
}
