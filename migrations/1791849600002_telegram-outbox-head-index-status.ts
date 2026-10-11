import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The status of every active message in the head index, for the status line (readBacklog()): it
// counts the pending and the processing messages apart. Without the status in the entries the count
// reads the row of every active message: a median of 1.2 s for a backlog of 1 M on 280 M rows, every
// interval of the status line on every node (docs/architecture/outbox-load-test.md, "The status
// line"). With it the count is an index-only scan.
//
// Not an index of its own on the status: the statistics of a long history see next to none of the
// active messages, so the planner valued a scan of such an index for one status as cheap as the
// primary key or the head index, and the completions looked their message up through it. With one
// status of 1 M pending messages such a lookup would read them all. Here the active messages keep
// one index.
//
// The index is rebuilt, and a plain build holds back the writes to the table while it runs, for a
// time that grows with the table.

const outbox = "telegram_outbox";
const headIndex = "telegram_outbox_active_chat_id_idx";
const activeStatusesPredicate = "status IN ('pending', 'processing')";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: headIndex });
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: headIndex,
        include: "status",
        where: activeStatusesPredicate,
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: headIndex });
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: headIndex,
        where: activeStatusesPredicate,
    });
}
