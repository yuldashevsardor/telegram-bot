import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The head of a group, the first of its active updates by update_id: the claim reads it, and so does
// every completion that finishes an update, for the active update left behind (releaseGroup()); the
// lease recovery finds the processing update of an expired group among the entries of the group.
// Without the index each head is found by scanning the whole table: 5 minutes a claim and up to
// 74 s a completion on 100 M rows (docs/architecture/inbox-load-test.md, "The head without an
// index"). Partial: the active updates are a sliver of the table, and none of these lookups reads
// the rest. A plain build holds back the writes to the table while it runs, for a time that grows
// with the table: 1 minute 39 seconds on the 100 M rows of the load test.
//
// Its status is in the predicate, so no update of an update row is HOT, and every update leaves
// dead entries in the index, which the head lookup walks until a vacuum cleans them. The vacuum
// options are those of telegram_outbox (1791153270752_telegram-outbox-head-index.ts, which has the
// reasons): the vacuum always cleans the indexes, and the dead rows that bring autovacuum are
// capped, whatever the size of the done history.

const inbox = "telegram_inbox";
const headIndex = "telegram_inbox_active_group_idx";
const autovacuumMaxThresholdRows = 100_000;

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(inbox, ["user_id", "chat_id", "update_id"], {
        name: headIndex,
        where: "status IN ('pending', 'processing')",
    });
    pgm.sql(`
        ALTER TABLE ${inbox} SET (
            vacuum_index_cleanup = ON,
            autovacuum_vacuum_max_threshold = ${autovacuumMaxThresholdRows}
        )
    `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`ALTER TABLE ${inbox} RESET (vacuum_index_cleanup, autovacuum_vacuum_max_threshold)`);
    pgm.dropIndex(inbox, [], { name: headIndex });
}
