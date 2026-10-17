import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// window_sent_count counts every pull of the window, a retry and a chat action included
// (docs/architecture/outbox.md, "Limits"): its comment called them the messages pulled, which reads
// as the messages that reached Telegram.

const table = "telegram_outbox_chats";
const column = "window_sent_count";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment:
            "The pulls in the window of a private chat, a retry and a chat action included; NULL for a group and before the first pull",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment: "The messages pulled in the window of a private chat; NULL for a group and before the first pull",
    });
}
