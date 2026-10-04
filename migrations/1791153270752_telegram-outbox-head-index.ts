import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

// The head of a chat, the first of its active messages by id: the pull reads it, and so does every
// completion that finishes a message, for the active message left behind (releaseChat()); the lease
// recovery finds the processing message of an expired chat among the entries of the chat. Without
// the index each head is found by walking the primary key past every done message of the table:
// minutes a pull on 100 M rows (docs/architecture/outbox-load-test.md). Partial: the active
// messages are a sliver of the table, and none of these lookups reads the rest. A plain build
// holds back the writes to the table while it runs, for a time that grows with the table: 2 minutes
// on the 100 M rows of the load test.
//
// Its status is in the predicate, so no update of a message is HOT, and every message leaves two
// dead entries in the index, which the head lookup walks until a vacuum cleans them. A plain vacuum
// skips the indexes while the dead rows lie on less than 2% of the pages, and autovacuum by default
// comes to the table once a fifth of it is dead: 20 M rows of 100 M. So the vacuum always cleans the
// indexes, and the dead rows that bring autovacuum are capped, whatever the size of the done
// history; a small table keeps the fifth, which comes sooner.

const outbox = "telegram_outbox";
const headIndex = "telegram_outbox_active_chat_id_idx";
const autovacuumMaxThresholdRows = 100_000;

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createIndex(outbox, ["chat_id", "id"], {
        name: headIndex,
        where: "status IN ('pending', 'processing')",
    });
    pgm.sql(`
        ALTER TABLE ${outbox} SET (
            vacuum_index_cleanup = on,
            autovacuum_vacuum_max_threshold = ${autovacuumMaxThresholdRows}
        )
    `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`ALTER TABLE ${outbox} RESET (vacuum_index_cleanup, autovacuum_vacuum_max_threshold)`);
    pgm.dropIndex(outbox, [], { name: headIndex });
}
