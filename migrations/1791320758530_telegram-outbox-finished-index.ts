import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The finished messages by the time they finished, for the cleanup (deleteFinishedMessages()): it
// deletes those finished before the cutoff of their retention, and without the index the call that
// finds none reads the whole table, 81 – 119 s on 100 M rows (docs/architecture/outbox-load-test.md,
// "The cleanup"). Partial: the cleanup deletes the done and the skipped messages alone, and the
// active and the failed ones need no entry. A plain build holds back the writes to the table while
// it runs, for a time that grows with the table: 2 minutes on the 100 M rows of the load test.

const outbox = "telegram_outbox";
const finishedIndex = "telegram_outbox_finished_at_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(outbox, ["finished_at"], {
        name: finishedIndex,
        where: "status IN ('done', 'skipped')",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: finishedIndex });
}
