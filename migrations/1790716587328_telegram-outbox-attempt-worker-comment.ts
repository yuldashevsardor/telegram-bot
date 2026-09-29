import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The recovery of an expired lease appends an attempt with no worker: the comment of the column
// gave every attempt one.

const table = "telegram_outbox";
const column = "attempts";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment:
            "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}; worker is null for an attempt ended by the recovery of an expired lease",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        comment: "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}",
    });
}
