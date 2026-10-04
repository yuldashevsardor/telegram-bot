import { expect } from "chai";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { Database } from "app/platform/database/database";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { RuntimeError } from "app/shared/errors";
import { sleep } from "app/shared/utils";
import type { InboxChannel } from "app/telegram/inbox/store/inbox-store.types";
import type { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";

// Longer than any lock wait of a passing run lasts, shorter than the timeout of the specs: a wait
// that never comes fails with its own message.
const LOCK_WAIT_DEADLINE_MS = 5_000;

// The database of a run is created by test/database-hook.ts; why the name arrives in a variable
// of its own rather than in DATABASE_NAME is there too.
export function testDatabaseName(): string {
    const name = process.env["TEST_DATABASE_NAME"];

    if (name === undefined) {
        throw new RuntimeError("TEST_DATABASE_NAME is not set: test/database-hook.ts did not run, rebuild the image (make rebuild)");
    }

    return name;
}

// The database settings of the config, pointed at the database of the run.
export async function testDatabaseSettings(): Promise<DatabaseSettings> {
    const env = await new ConfigEnvStorage().load();
    // The config requires BOT_TOKEN while a database spec needs only the database: without the
    // substitution it would depend on the token in .env.
    const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

    return { ...settings, database: testDatabaseName() };
}

// The payloads of the notifications of a channel, from the moment the listening starts.
export async function listenTo(database: Database, channel: OutboxChannel | InboxChannel): Promise<string[]> {
    const payloads: string[] = [];
    await database.sql.listen(channel, (payload) => payloads.push(payload));

    return payloads;
}

// Waits until at least `count` queries of the database wait for a lock. The observer is a client of
// its own: calls waiting for a lock hold connections of the spec's other clients, and a poll through
// the same pool would queue behind them at a small DATABASE_CONNECTION_LIMIT, hanging past the
// deadline instead of failing on it.
export async function waitForLockWaiters(observer: Database, count: number): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;

    for (;;) {
        if (Date.now() > deadline) {
            expect.fail(`fewer than ${count} queries waited for a lock by the deadline`);
        }

        const [row] = await observer.sql<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
        `;

        if (row !== undefined && row.waiting >= count) {
            return;
        }

        await sleep(5);
    }
}
