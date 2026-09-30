import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The recovery of an expired lease appends an attempt with no worker: the comment of attempts gave
// every attempt one. It completes under the token of the pull it recovers, so a late write of the
// node presumed dead that commits first still matches: the comment of lock_token said it never did.

const outbox = "telegram_outbox";
const chats = "telegram_outbox_chats";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(outbox, "attempts", {
        comment:
            "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}; worker is null for an attempt ended by the recovery of an expired lease",
    });
    pgm.alterColumn(chats, "lock_token", {
        comment:
            "The token of the current pull: a write of an earlier pull does not match it, and neither does a late write of a node presumed dead once its lease is recovered",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(outbox, "attempts", {
        comment: "An array of {started_at, finished_at, worker: {host, pid, worker_id}, error}",
    });
    pgm.alterColumn(chats, "lock_token", {
        comment: "The token of the current pull: a late write of a node presumed dead does not match it",
    });
}
