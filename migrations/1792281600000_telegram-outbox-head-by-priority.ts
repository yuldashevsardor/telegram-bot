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
// A node on the code before this migration that writes to the outbox after it reads the head by id:
// its pull sends the first message of a chat by id, its lease recovery misses the lease of a message
// pulled ahead of older ones of its chat, and its pushes and completions set the copy from the head
// by id.
// Every node that writes to the outbox is to run the new code once the migration is applied.

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
    pgm.sql(`
        UPDATE ${chats}
        SET head_priority = (
            SELECT priority
            FROM ${outbox}
            WHERE chat_id = ${chats}.chat_id
              AND ${activeStatusesPredicate}
            ORDER BY priority, id
            LIMIT 1
        )
    `);
    pgm.alterColumn(outbox, "id", {
        comment: "The order of the messages of one priority inside a chat",
    });
    pgm.alterColumn(chats, "head_priority", {
        comment: "The priority of the head, the first active message of the chat by priority, then by id; NULL without one",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(outbox, [], { name: headIndex });
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: headIndex,
        include: "status",
        where: activeStatusesPredicate,
    });
    pgm.sql(`
        UPDATE ${chats}
        SET head_priority = (
            SELECT priority
            FROM ${outbox}
            WHERE chat_id = ${chats}.chat_id
              AND ${activeStatusesPredicate}
            ORDER BY id
            LIMIT 1
        )
    `);
    pgm.alterColumn(outbox, "id", {
        comment: "The order of the messages inside a chat",
    });
    pgm.alterColumn(chats, "head_priority", {
        comment: "The priority of the head, the first active message of the chat; NULL without one",
    });
}
