import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The failed updates of a group, newest first, for the unblock (lockBlockedGroup()): it looks up the
// failed update that blocked the group, the one that failed last. Without the index the lookup reads
// the whole table under the lock of the group row, 135 – 175 s a call on 250 M rows
// (docs/architecture/inbox-load-test.md, "The unblocking"). Partial: the head index holds the active
// updates alone and the index of the cleanup the done and the skipped ones, and the lookup needs
// the failed ones only. A failed update is never deleted, and only the unblock takes one out of
// failed, so the index grows with the failures that do not block their group. A plain build holds
// back the writes to the table while it runs, for a time that grows with the table: 32 minutes on
// the 250 M rows of the load test.

const inbox = "telegram_inbox";
const failedGroupIndex = "telegram_inbox_failed_group_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(inbox, ["user_id", "chat_id", { name: "finished_at", sort: "DESC" }, { name: "update_id", sort: "DESC" }], {
        name: failedGroupIndex,
        where: "status = 'failed'",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(inbox, [], { name: failedGroupIndex });
}
