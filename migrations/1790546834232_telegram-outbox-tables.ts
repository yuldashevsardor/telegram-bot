import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The outbox of Telegram calls: the tables and the columns of all its stages at once, so that the
// later stages need no migration of their own (docs/architecture/outbox.md).

const outbox = "telegram_outbox";
const chats = "telegram_outbox_chats";
const botLimits = "telegram_bot_limits";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable(outbox, {
        id: {
            type: "bigint",
            primaryKey: true,
            sequenceGenerated: { precedence: "ALWAYS" },
            comment: "The order of the messages inside a chat",
        },
        chat_id: {
            type: "bigint",
            notNull: true,
            comment: "The group: the order and the chat limit",
        },
        method: {
            type: "text",
            notNull: true,
            comment: "Bot API method",
        },
        payload: {
            type: "jsonb",
            notNull: true,
            comment: "Bot API method parameters",
        },
        priority: {
            type: "integer",
            notNull: true,
            comment: "A lower value goes first",
        },
        status: {
            type: "text",
            notNull: true,
            comment: "OutboxStatus: pending -> processing -> done / failed / skipped",
        },
        attempts: {
            type: "jsonb",
            notNull: true,
            default: pgm.func("'[]'::jsonb"),
            comment: "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}",
        },
        response: {
            type: "jsonb",
            notNull: false,
            comment: "The Telegram response handed to the awaiting caller",
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

    pgm.createTable(chats, {
        chat_id: {
            type: "bigint",
            primaryKey: true,
            comment: "The chat; its row is the lock of the chat",
        },
        state: {
            type: "text",
            notNull: true,
            comment: "OutboxChatState: idle, ready, processing, blocked",
        },
        next_attempt_at: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
            comment:
                "When the chat may be pulled next; for now it only orders the chats in turn, the chat limit and the retry delay will rework it",
        },
        locked_until: {
            type: "timestamptz",
            notNull: false,
            comment: "Until when the node that pulled the head of the chat holds it",
        },
        lock_token: {
            type: "uuid",
            notNull: false,
            comment: "The token of the current pull: a late write of a node presumed dead does not match it",
        },
        created_at: {
            type: "createdAt",
        },
        updated_at: {
            type: "updatedAt",
        },
    });

    pgm.createTable(botLimits, {
        id: {
            type: "integer",
            primaryKey: true,
            comment: "The table holds one row, id = 1",
        },
        next_send_at: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
            comment: "The common limit of the bot",
        },
        paused_until: {
            type: "timestamptz",
            notNull: false,
            comment: "The shared pause after a 429",
        },
        created_at: {
            type: "createdAt",
        },
        updated_at: {
            type: "updatedAt",
        },
    });

    pgm.sql(`INSERT INTO ${botLimits} (id) VALUES (1)`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable(botLimits);
    pgm.dropTable(chats);
    pgm.dropTable(outbox);
}
