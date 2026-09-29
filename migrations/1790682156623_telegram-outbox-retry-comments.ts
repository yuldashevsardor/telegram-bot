import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// A retry now moves next_attempt_at and takes a message back from processing to pending: the
// comments said the retry delay would come later and the status went one way only.

const outbox = "telegram_outbox";
const chats = "telegram_outbox_chats";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(outbox, "status", {
        comment: "OutboxStatus: pending -> processing -> done / failed / skipped; a retry takes processing back to pending",
    });
    pgm.alterColumn(chats, "next_attempt_at", {
        comment:
            "When the chat may be pulled next: a pull moves it by the chat limit, a retry by the retry delay; ready chats of one priority go in its order",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(outbox, "status", {
        comment: "OutboxStatus: pending -> processing -> done / failed / skipped",
    });
    pgm.alterColumn(chats, "next_attempt_at", {
        comment:
            "When the chat may be pulled next: a pull moves it by the chat limit; ready chats of one priority go in its order; the retry delay will move it too",
    });
}
