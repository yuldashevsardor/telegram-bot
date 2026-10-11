import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// Autovacuum comes to telegram_outbox for its dead rows alone, not for its inserts. PostgreSQL also
// brings a vacuum after autovacuum_vacuum_insert_threshold inserts plus
// autovacuum_vacuum_insert_scale_factor times the rows on the pages not frozen yet, and the done
// history gets frozen: on 280 M rows the threshold came to some 1 700 inserts, a minute at the
// common limit of 30 messages a second. Each such vacuum read every index whole, 12 GB in 60 to
// 87 s, for a few hundred dead rows: vacuum_index_cleanup = ON of
// 1791153270752_telegram-outbox-head-index.ts keeps a vacuum from skipping the indexes
// (docs/architecture/outbox-load-test.md, "Autovacuum in every run").
//
// The insert vacuum is there for a table that is only inserted into, which no vacuum of dead rows
// would visit before the vacuum against wraparound. Every outbox message is updated twice after its
// insert, so the vacuum of the dead rows, capped at 100 000 by the same migration, comes to the
// table anyway and cleans the dead entries of the head index. The vacuum against wraparound does
// not depend on this setting. The cost: the pages a push fills stay unmarked in the visibility map
// until that vacuum, and the status line reads the rows on them meanwhile.

const outbox = "telegram_outbox";
const insertVacuumOff = -1;

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`ALTER TABLE ${outbox} SET (autovacuum_vacuum_insert_threshold = ${insertVacuumOff})`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`ALTER TABLE ${outbox} RESET (autovacuum_vacuum_insert_threshold)`);
}
