import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// A retry now takes an update back from processing to pending and moves next_attempt_at by the retry
// delay: the comments said the status went one way only and only a claim moved the time.

const inbox = "telegram_inbox";
const groups = "telegram_inbox_groups";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(inbox, "status", {
        comment: "InboxStatus: pending -> processing -> done / failed / skipped; a retry takes processing back to pending",
    });
    pgm.alterColumn(groups, "next_attempt_at", {
        comment:
            "When the group may be claimed next: a claim moves it to now(), so the groups are served in turn; a retry by the retry delay",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(inbox, "status", {
        comment: "InboxStatus: pending -> processing -> done / failed / skipped",
    });
    pgm.alterColumn(groups, "next_attempt_at", {
        comment: "When the group may be claimed next; the claim moves it to now(), so the groups are served in turn",
    });
}
