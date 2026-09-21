import "reflect-metadata";
import { expect } from "chai";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import { PgsqlStorage } from "app/telegram/session/pgsql-storage";
import { testDatabaseName } from "test/database.helper";

const KEY = "42:42";

describe("PgsqlStorage", function () {
    let database: Database;
    let storage: PgsqlStorage;

    before(async function () {
        const env = await new ConfigEnvStorage().load();
        // The config demands BOT_TOKEN while the spec needs only the database: without the stub it would depend on the token in .env.
        const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

        database = new Database({ ...settings, database: testDatabaseName() }, false);
        storage = new PgsqlStorage(database);
    });

    beforeEach(async function () {
        await database.sql`truncate sessions`;
    });

    after(async function () {
        // A failed before never gets to assign database, and a failing after would hide the reason for it.
        await database?.close();
    });

    it("reads nothing for a key that was never written", async function () {
        expect(await storage.read(KEY)).to.equal(undefined);
    });

    // The insert is positional: a column added by a migration before value would be taken by the
    // payload instead, and the read would give back null (docs/architecture/invariants.md).
    it("reads back the written payload", async function () {
        await storage.write(KEY, { requestCount: 1 });

        expect(await storage.read(KEY)).to.deep.equal({ requestCount: 1 });
    });

    it("replaces the payload of a key that is already written", async function () {
        await storage.write(KEY, { requestCount: 1 });
        await storage.write(KEY, { requestCount: 2 });

        expect(await storage.read(KEY)).to.deep.equal({ requestCount: 2 });
    });

    // now() is the start time of the transaction, and every write has its own. The comparison is
    // done in SQL: Date loses microseconds, and writes within one millisecond would come out equal.
    it("moves updated_time on rewrite and keeps created_time", async function () {
        await storage.write(KEY, { requestCount: 1 });

        const [first] = await database.sql<{ created: string }[]>`
            select created_time::text as created
            from sessions
            where key = ${KEY}
        `;

        await storage.write(KEY, { requestCount: 2 });

        const [second] = await database.sql<{ created: string; moved: boolean }[]>`
            select created_time::text as created, updated_time > created_time as moved
            from sessions
            where key = ${KEY}
        `;

        expect(second?.created).to.equal(first?.created);
        expect(second?.moved).to.equal(true);
    });

    it("deletes the key", async function () {
        await storage.write(KEY, { requestCount: 1 });
        await storage.delete(KEY);

        expect(await storage.read(KEY)).to.equal(undefined);
    });
});
