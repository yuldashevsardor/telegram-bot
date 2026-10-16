import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The window of a private chat: Telegram counts some 100 messages of a private chat in a window of
// 5 minutes, opened by the first message and reset whole, which a cooldown cannot express
// (docs/architecture/real-bot-load-test.md). The pull opens and counts the window
// (docs/architecture/outbox.md, "Limits"). A private chat already there has no window, and its
// first pull after the migration opens one.

const chats = "telegram_outbox_chats";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.addColumns(chats, {
        window_started_at: {
            type: "timestamptz",
            notNull: false,
            comment: "The pull that opened the window of a private chat; NULL for a group and before the first pull",
        },
        window_sent_count: {
            type: "integer",
            notNull: false,
            comment: "The messages pulled in the window of a private chat; NULL for a group and before the first pull",
        },
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropColumns(chats, ["window_started_at", "window_sent_count"]);
}
