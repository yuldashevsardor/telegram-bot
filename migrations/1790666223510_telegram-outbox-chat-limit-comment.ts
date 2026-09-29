import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The pull now holds a chat back until next_attempt_at: the comment of the column said it only
// ordered the chats.

const table = "telegram_outbox_chats";
const column = "next_attempt_at";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment:
            "When the chat may be pulled next: a pull moves it by the chat limit; ready chats of one priority go in its order; the retry delay will move it too",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment:
            "When the chat may be pulled next; for now it only orders the chats in turn, the chat limit and the retry delay will rework it",
    });
}
