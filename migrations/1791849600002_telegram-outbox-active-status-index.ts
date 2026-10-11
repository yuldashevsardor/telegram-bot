import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The status of every active message, for the status line (readBacklog()): it counts the pending and
// the processing messages apart. The entries of the head index do not hold the status, so through it
// the count reads the row of every active message: a median of 1.2 s for a backlog of 1 M on 280 M
// rows, every interval of the status line on every node (docs/architecture/outbox-load-test.md,
// "The status line"). Here the count is an index-only scan. Partial, with the predicate of the head
// index: the count needs the active messages alone. Its key takes two values, so the entries of one
// value lie in the order of the rows in the table: where the visibility map does not yet mark a page
// all-visible, the count reads that page once, not once a message. A plain build holds back the
// writes to the table while it runs, for a time that grows with the table: 4 minutes on 280 M rows.

const outbox = "telegram_outbox";
const activeStatusIndex = "telegram_outbox_active_status_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(outbox, ["status"], {
        name: activeStatusIndex,
        where: "status IN ('pending', 'processing')",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: activeStatusIndex });
}
