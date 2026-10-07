import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The ready groups in the order of the claim, next_attempt_at and the group key: the claim takes the
// first limit of them before it looks up their heads (docs/architecture/inbox.md, "Claim"). Without
// the index the claim reads every group and sorts the ready ones, 20 – 28 ms on 100 000 ready
// groups (docs/architecture/inbox-load-test.md, "The claim of 100 k groups").
// Partial: the claim reads the ready groups alone.

const groups = "telegram_inbox_groups";
const readyIndex = "telegram_inbox_ready_groups_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(groups, ["next_attempt_at", "user_id", "chat_id"], {
        name: readyIndex,
        where: "state = 'ready'",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(groups, [], { name: readyIndex });
}
