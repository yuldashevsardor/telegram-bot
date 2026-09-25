import "reflect-metadata";
import { expect } from "chai";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import { Database } from "app/platform/database/database";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";
import { testDatabaseName } from "test/database.helper";

describe("Database", function () {
    it("connects with the settings from the config by default", async function () {
        await fillApplicationContext(testDatabaseEnv());

        let database: Database;

        try {
            database = new Database();
        } finally {
            resetApplicationContext();
        }

        try {
            const [row] = await database.sql<{ name: string }[]>`select current_database() as name`;

            expect(row?.name).to.equal(testDatabaseName());
        } finally {
            await database.close();
        }
    });

    // This is why Application.setup() calls check(): without it an unreachable database
    // would surface only on the first update.
    it("does not connect until the first query", async function () {
        const database = new Database({ ...settings(), database: `${testDatabaseName()}_missing` }, false);

        try {
            await database.check();
            expect.fail("check() was expected to reject");
        } catch (error) {
            // 3D000 — invalid_catalog_name: the database does not exist.
            expect(error).to.have.property("code", "3D000");
        } finally {
            await database.close();
        }
    });

    it("passes check() on a reachable database", async function () {
        const database = new Database(settings(), false);

        try {
            await database.check();
        } finally {
            await database.close();
        }
    });

    it("rejects queries after close()", async function () {
        const database = new Database(settings(), false);

        await database.check();
        await database.close();

        try {
            await database.check();
            expect.fail("check() was expected to reject after close()");
        } catch (error) {
            expect(error).to.have.property("code", "CONNECTION_ENDED");
        }
    });

    // The claim of storage.md: debug in postgres prints nothing, it only makes the fields of a
    // failed query's error enumerable.
    it("exposes the failed query as enumerable fields outside production", async function () {
        expect(await failedQueryKeys(false)).to.include.members(["query", "parameters"]);
    });

    it("keeps the failed query out of the enumerable fields in production", async function () {
        const keys = await failedQueryKeys(true);

        // One field at a time: not.include.members means "not a superset" and would pass
        // with only one of the two hidden.
        expect(keys).to.not.include("query");
        expect(keys).to.not.include("parameters");
    });
});

// The environment of the container with DATABASE_NAME replaced by the database of the run.
// test/database-hook.ts creates that database and says why its name has a variable of its own.
// The config requires BOT_TOKEN, which the database does not need: without the substitution
// the spec would depend on the token in .env.
function testDatabaseEnv(): RawConfig {
    return { ...process.env, BOT_TOKEN: "test-token", DATABASE_NAME: testDatabaseName() };
}

function settings(): DatabaseSettings {
    return new ConfigValuesBuilder().build(testDatabaseEnv()).database;
}

async function failedQueryKeys(isProduction: boolean): Promise<string[]> {
    const database = new Database(settings(), isProduction);

    try {
        await database.sql`select * from missing_table where id = ${1}`;
        expect.fail("the query was expected to reject");
    } catch (error) {
        // 42P01 is undefined_table. The check also stops the AssertionError of expect.fail above.
        expect(error).to.have.property("code", "42P01");

        return Object.keys(error as object);
    } finally {
        await database.close();
    }
}
