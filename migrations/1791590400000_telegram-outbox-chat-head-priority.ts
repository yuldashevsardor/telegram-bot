import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The priority of the head on the chat row, so the pull reads the ready chats in its order from an
// index and stops at its batch. Read from the head, it looked up the head of every ready chat and
// sorted them all before it took the first: 228 ms a pull(30) of 100 000 ready chats
// (docs/architecture/outbox-load-test.md). The store sets the copy with every write that makes a
// chat ready or moves its head (docs/architecture/outbox.md, "Tables"). The index of the next due
// time serves the nearest next_attempt_at of the ready chats, which the pull answers with: without
// it the pull read every chat for it.

const outbox = "telegram_outbox";
const chats = "telegram_outbox_chats";
const pullIndex = "telegram_outbox_chats_ready_pull_idx";
const dueIndex = "telegram_outbox_chats_ready_next_attempt_at_idx";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.addColumn(chats, {
        head_priority: {
            type: "integer",
            notNull: false,
            comment: "The priority of the head, the first active message of the chat; NULL without one",
        },
    });
    pgm.sql(`
        UPDATE ${chats}
        SET head_priority = (
            SELECT priority
            FROM ${outbox}
            WHERE chat_id = ${chats}.chat_id
              AND status IN ('pending', 'processing')
            ORDER BY id
            LIMIT 1
        )
    `);
    pgm.createIndex(chats, ["head_priority", "next_attempt_at", "chat_id"], {
        name: pullIndex,
        where: "state = 'ready'",
    });
    pgm.createIndex(chats, ["next_attempt_at"], {
        name: dueIndex,
        where: "state = 'ready'",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropIndex(chats, [], { name: dueIndex });
    pgm.dropIndex(chats, [], { name: pullIndex });
    pgm.dropColumn(chats, "head_priority");
}
