import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The failed messages of a chat, newest first, for the unblock (lockBlockedChat()): it looks up the
// failed message that blocked the chat, the one that failed last. Without the index the lookup reads
// the whole table under the lock of the chat row, 188 – 227 s a call on 280 M rows
// (docs/architecture/outbox-load-test.md, "The unblocking"). Partial: the head index holds the active
// messages alone and the index of the cleanup the done and the skipped ones, and the lookup needs
// the failed ones only. A failed message is never deleted, and only the unblock takes one out of
// failed, so the index grows with the failures that do not block their chat. A plain build holds
// back the writes to the table while it runs, for a time that grows with the table.

const outbox = "telegram_outbox";
const failedChatIndex = "telegram_outbox_failed_chat_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(outbox, ["chat_id", { name: "finished_at", sort: "DESC" }, { name: "id", sort: "DESC" }], {
        name: failedChatIndex,
        where: "status = 'failed'",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: failedChatIndex });
}
