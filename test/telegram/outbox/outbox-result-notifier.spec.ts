import "reflect-metadata";
import { expect } from "chai";
import { Database } from "app/platform/database/database";
import { OutboxResultNotifier } from "app/telegram/outbox/outbox-result-notifier";
import { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";
import { sleep } from "app/shared/utils";
import { testDatabaseSettings } from "test/database.helper";
import { listenTo, waitUntil } from "test/telegram/outbox/outbox-result-notifier.helper";

const MESSAGE_ID = 42;
const OTHER_MESSAGE_ID = 43;
// How long the open transaction waits for a notification that must not come before its commit.
const QUIET_MS = 100;
// Longer than NOTIFICATION_DEADLINE_MS of the helper: a notification that never comes fails there.
const SPEC_TIMEOUT_MS = 10_000;

describe("OutboxResultNotifier", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let database: Database;
    // The listening client, one per test: closed at the end, it takes its LISTEN connection along.
    let listener: Database;
    const notifier = new OutboxResultNotifier();

    before(async function () {
        database = new Database(await testDatabaseSettings(), false);
    });

    beforeEach(async function () {
        listener = new Database(await testDatabaseSettings(), false);
    });

    afterEach(async function () {
        await listener.close();
    });

    after(async function () {
        await database?.close();
    });

    // sql.notify() of postgres.js would notify at once, through the pool.
    it("notifies the finished channel with the id once the transaction commits, not before", async function () {
        const payloads = await listenTo(listener, OutboxChannel.Finished);

        await database.sql.begin(async (sql) => {
            await notifier.notify(sql, MESSAGE_ID);
            await sleep(QUIET_MS);

            expect(payloads).to.be.empty;
        });

        await waitUntil(() => payloads.length > 0, "no finished notification came");
        expect(payloads).to.deep.equal([String(MESSAGE_ID)]);
    });

    it("notifies nothing when the transaction rolls back", async function () {
        const payloads = await listenTo(listener, OutboxChannel.Finished);
        const rollback = new Error("roll back");

        await database.sql
            .begin(async (sql) => {
                await notifier.notify(sql, MESSAGE_ID);
                throw rollback;
            })
            .catch((error: unknown) => expect(error).to.equal(rollback));
        // A committed notification after the rolled back one: once it has come, the rolled back one
        // would have come before it.
        await database.sql.begin((sql) => notifier.notify(sql, OTHER_MESSAGE_ID));

        await waitUntil(() => payloads.length > 0, "no finished notification came");
        expect(payloads).to.deep.equal([String(OTHER_MESSAGE_ID)]);
    });
});
