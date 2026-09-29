import { injectable } from "inversify";
import type { TransactionSql } from "postgres";
import { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";

// Tells the waiters of every node that a message has its outcome (docs/architecture/outbox.md,
// "Waiting for the result").
@injectable()
export class OutboxResultNotifier {
    // Every transaction that moves a message into done, failed or skipped calls it: a caller waiting on
    // another node learns of the outcome only from the poll otherwise (docs/architecture/invariants.md).
    // The notification goes through sql of that transaction, so PostgreSQL delivers it on commit and
    // the waiter that reads the row on it sees the outcome. Not sql.notify() of postgres.js: it runs
    // on the pool whatever sql it is called on (notify() in its src/index.js), so inside a transaction
    // it would notify before the commit.
    public async notify(sql: TransactionSql, messageId: number): Promise<void> {
        await sql`SELECT pg_notify(${OutboxChannel.Finished}, ${String(messageId)})`;
    }
}
