import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The outbox of Telegram calls: the tables, the columns and the indexes of all its stages at once,
// so that the later stages need no migration of their own (docs/architecture/outbox.md).

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
            type: "smallint",
            notNull: true,
            comment: "A lower value goes first",
        },
        status: {
            type: "text",
            notNull: true,
            default: "pending",
            check: "status in ('pending', 'processing', 'done', 'failed', 'skipped')",
            comment: "pending -> processing -> done / failed / skipped",
        },
        attempts: {
            type: "jsonb",
            notNull: true,
            default: pgm.func("'[]'::jsonb"),
            comment: "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}",
        },
        locked_until: {
            type: "timestamptz",
            notNull: false,
            comment: "Until when the node that claimed the message holds it",
        },
        lock_token: {
            type: "uuid",
            notNull: false,
            comment: "The token of the current claim: a late write of a node presumed dead does not match it",
        },
        response: {
            type: "jsonb",
            notNull: false,
            comment: "The Telegram response handed to the awaiting caller",
        },
        created_at: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
        },
        finished_at: {
            type: "timestamptz",
            notNull: false,
            comment: "The final outcome, for the cleanup",
        },
    });

    // The head of a chat: its first message by id among the active ones.
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: "telegram_outbox_head_idx",
        where: "status in ('pending', 'processing', 'failed')",
    });
    // The claims of dead nodes.
    pgm.createIndex(outbox, "locked_until", { name: "telegram_outbox_lease_idx", where: "status = 'processing'" });
    // The cleanup of finished rows.
    pgm.createIndex(outbox, "finished_at", { name: "telegram_outbox_cleanup_idx", where: "status in ('done', 'skipped')" });

    pgm.createTable(chats, {
        chat_id: {
            type: "bigint",
            primaryKey: true,
            comment: "The chat; its row is the lock of the chat",
        },
        state: {
            type: "text",
            notNull: true,
            check: "state in ('idle', 'ready', 'processing', 'blocked')",
            comment: "idle: no active message; ready: the head can be claimed; processing: the head is claimed; blocked: a failed head",
        },
        next_send_at: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
            comment: "The chat limit and the retry delay",
        },
        head_priority: {
            type: "smallint",
            notNull: false,
            comment: "The priority of the head; null while the chat has no active message",
        },
    });

    // What the claim walks.
    pgm.createIndex(chats, ["head_priority", "next_send_at"], { name: "telegram_outbox_chats_ready_idx", where: "state = 'ready'" });

    pgm.createTable(botLimits, {
        id: {
            type: "boolean",
            primaryKey: true,
            default: true,
            check: "id",
            comment: "Keeps the table at one row: a second insert breaks the primary key",
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
    });

    pgm.sql(`insert into ${botLimits} default values`);

    // A message rewrites its row about three times and its chat row as often, and the bot row is
    // rewritten on every claim. By default autovacuum waits for dead versions to reach 20% of a
    // table, and a full page puts the new version of a row on another page. The numbers are a
    // starting point, not a measurement.
    pgm.sql(`
        alter table ${outbox} set (
            fillfactor = 90,
            autovacuum_vacuum_scale_factor = 0.01,
            autovacuum_analyze_scale_factor = 0.01
        )
    `);
    pgm.sql(`
        alter table ${chats} set (
            fillfactor = 50,
            autovacuum_vacuum_scale_factor = 0,
            autovacuum_vacuum_threshold = 1000,
            autovacuum_analyze_scale_factor = 0.05
        )
    `);
    pgm.sql(`
        alter table ${botLimits} set (
            fillfactor = 10,
            autovacuum_vacuum_scale_factor = 0,
            autovacuum_vacuum_threshold = 100
        )
    `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable(botLimits);
    pgm.dropTable(chats);
    pgm.dropTable(outbox);
}
