import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The head of a chat is now its first active message by priority, then by id: a reply goes before
// the bulk messages of its own chat, not only before other chats (docs/architecture/outbox.md,
// "Tables", the head). The head index leads on the priority after the chat, so the head of a chat is
// still the first entry of the chat in it. The copies of the head's priority are read again under the
// new rule: a chat with bulk messages and a reply behind them has the reply's priority now.
//
// The index is dropped first and built again, as in
// 1791849600002_telegram-outbox-head-index-status.ts, for the same reason: the drop takes the
// strongest lock on the table at once, and a build beside the old index would deadlock with a
// completion when the drop upgraded its lock.
//
// The migration is applied with every node that writes to the outbox stopped. It holds
// telegram_outbox locked and then updates the chat rows, while a push, a completion and an unblock
// lock their chat row first and then use telegram_outbox: one of them during the build closes a
// lock cycle, PostgreSQL aborts the migration, and the build of 1.5 minutes on 100 M rows is rolled
// back (docs/architecture/outbox-load-test.md, "The head by priority"). A node on the code before
// it would be wrong after it besides: it reads the head by id, so its pull sends the first message
// of a chat by id, its lease recovery misses the lease of a message pulled ahead of older ones of
// its chat, and its pushes and completions set the copy from the head by id.

const outbox = "telegram_outbox";
const chats = "telegram_outbox_chats";
const headIndex = "telegram_outbox_active_chat_id_idx";
const activeStatusesPredicate = "status IN ('pending', 'processing')";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: headIndex });
    pgm.createIndex(outbox, ["chat_id", "priority", "id"], {
        name: headIndex,
        include: "status",
        where: activeStatusesPredicate,
    });
    // Only the copies that change are written, as pushBatch() writes them: most chats keep theirs.
    const headPrioritySubquery = `(
        SELECT priority
        FROM ${outbox}
        WHERE chat_id = ${chats}.chat_id
          AND ${activeStatusesPredicate}
        ORDER BY priority, id
        LIMIT 1
    )`;
    pgm.sql(`
        UPDATE ${chats}
        SET head_priority = ${headPrioritySubquery}
        WHERE head_priority IS DISTINCT FROM ${headPrioritySubquery}
    `);
    pgm.alterColumn(outbox, "id", {
        comment: "The order of the messages of one priority inside a chat",
    });
    pgm.alterColumn(chats, "head_priority", {
        comment: "The priority of the head, the first active message of the chat by priority, then by id; NULL without one",
    });
}

// Applied with the nodes stopped as up() is, and with no message processing: the lease recovery of
// the code before reads the processing message as the head by id, and a message pulled ahead of
// older ones of its chat would keep its chat processing, its lease never recovered.
export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: headIndex });
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: headIndex,
        include: "status",
        where: activeStatusesPredicate,
    });
    const headPrioritySubquery = `(
        SELECT priority
        FROM ${outbox}
        WHERE chat_id = ${chats}.chat_id
          AND ${activeStatusesPredicate}
        ORDER BY id
        LIMIT 1
    )`;
    pgm.sql(`
        UPDATE ${chats}
        SET head_priority = ${headPrioritySubquery}
        WHERE head_priority IS DISTINCT FROM ${headPrioritySubquery}
    `);
    pgm.alterColumn(outbox, "id", {
        comment: "The order of the messages inside a chat",
    });
    pgm.alterColumn(chats, "head_priority", {
        comment: "The priority of the head, the first active message of the chat; NULL without one",
    });
}
