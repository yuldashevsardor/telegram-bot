import { inject, injectable } from "inversify";
import type { Database, Sql } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import type { FinishedOutboxMessage, FinishedOutboxRow } from "app/telegram/outbox/store/outbox-store.types";
import { FINISHED_STATUSES, OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";

// What the waiter reads about the messages that have their outcome: the notifications that
// OutboxStore sends on it, and the rows (docs/architecture/outbox.md, "Waiting for the result").
@injectable()
export class OutboxFinishedMessageReader {
    private readonly sql: Sql;

    public constructor(@inject<Database>(Tokens.Platform.Database) database: Database) {
        this.sql = database.sql;
    }

    // The messages among messageIds that are in a final status.
    public async find(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        // The ids go as one jsonb array, not sql.array() as in OutboxStore.pushBatch(): postgres.js
        // takes the OID of an array type from the types it loads on connecting. As the first query of
        // a new client, which the first poll of the waiter often is, sql.array() here failed with
        // "cannot cast type bigint to bigint[]"; pushBatch() in its transaction did not. Nor a list of
        // parameters: every number of ids would be a text of its own, and a prepared statement of its
        // own on every connection.
        const rows = await this.sql<FinishedOutboxRow[]>`
            SELECT id, status, response, attempts -> -1 -> 'error' AS error
            FROM telegram_outbox
            WHERE id IN (SELECT jsonb_array_elements_text(${this.sql.json(messageIds)})::bigint)
              AND status IN ${this.sql(FINISHED_STATUSES)}
        `;

        return rows.map((row) => ({ id: Number(row.id), status: row.status, response: row.response, error: row.error }));
    }

    // onFinished gets the id of every message that reaches a final status on any node. onListen is
    // called every time the listening starts: the first time and after a reconnect, since a
    // notification sent while the connection was down is lost. Resolves once the listening starts.
    // LISTEN takes a connection of its own, outside the pool, until Database.close()
    // (docs/architecture/storage.md).
    public async listen(onFinished: (messageId: number) => void, onListen: () => void): Promise<void> {
        await this.sql.listen(OutboxChannel.Finished, (payload) => onFinished(Number(payload)), onListen);
    }
}
