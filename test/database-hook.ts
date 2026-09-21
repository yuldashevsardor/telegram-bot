import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { runner } from "node-pg-migrate";
import postgres from "postgres";
import type { Sql } from "app/platform/database/database";
import { RuntimeError } from "app/shared/errors";

// The mocha root hook (.mocharc.json): a database per run inside the shared Postgres from
// docker-compose.db.yml. Why this and not a transaction rolled back per test or testcontainers —
// docs/architecture/testing.md, "The test database".
//
// The name of the database reaches the specs through TEST_DATABASE_NAME rather than by
// substituting DATABASE_NAME: the hook is wired in .mocharc.json, which lives in the image, and
// in a stale image it is not wired in. A spec without a variable of its own fails, while with a
// substituted DATABASE_NAME it would silently truncate the shared database of running bots.

const TEST_DATABASE_NAME = "TEST_DATABASE_NAME";
const HOOK_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_SECONDS = 5;

type MigrateConfig = {
    "migrations-dir": string;
    "migrations-table": string;
};

let databaseName: string | undefined;

function env(name: string): string {
    const value = process.env[name];

    if (value === undefined || value === "") {
        throw new RuntimeError(`${name} is not set: tests run in the app container, start them with make test`);
    }

    return value;
}

// The superuser only creates and drops the database. The specs and the migrations go to it as
// the application user, like the bot: that way the tables belong to it too, and the permissions
// checked are the ones checked in production.
function connectAsSuperuser(): Sql {
    return postgres({
        host: env("DATABASE_HOST"),
        port: Number(env("DATABASE_PORT")),
        database: "postgres",
        username: env("DATABASE_SUPERUSER_NAME"),
        password: env("DATABASE_SUPERUSER_PASSWORD"),
        connect_timeout: CONNECT_TIMEOUT_SECONDS,
    });
}

async function createDatabase(name: string): Promise<void> {
    // Before the try: a missing variable has to fail with its own error, not under the wrapping below.
    const owner = env("DATABASE_USER_NAME");
    const sql = connectAsSuperuser();

    try {
        await sql`create database ${sql(name)} with owner ${sql(owner)}`;
    } catch (error) {
        // A refusal is not only about connectivity (a password, a role), so the reason goes into cause
        // and the hint about make db-up is conditional.
        throw new RuntimeError(
            "Could not create the test database, see the cause; if PostgreSQL is unreachable, start it with make db-up",
            {
                cause: error,
            },
        );
    } finally {
        await sql.end();
    }
}

// The migrations directory and table come from migrate.json, as for node-pg-migrate in the
// container before the bot starts: the database of a run is assembled by the same set as the
// working one.
async function migrate(name: string): Promise<void> {
    const config = JSON.parse(readFileSync("migrate.json", "utf8")) as MigrateConfig;

    await runner({
        databaseUrl: {
            host: env("DATABASE_HOST"),
            port: Number(env("DATABASE_PORT")),
            database: name,
            user: env("DATABASE_USER_NAME"),
            password: env("DATABASE_USER_PASSWORD"),
        },
        dir: config["migrations-dir"],
        migrationsTable: config["migrations-table"],
        direction: "up",
        log: () => {},
    });
}

async function dropDatabase(name: string): Promise<void> {
    const sql = connectAsSuperuser();

    try {
        // force tears down the connections a spec did not close: without it the drop would fail and
        // the database would be left hanging in the shared Postgres.
        await sql`drop database ${sql(name)} with (force)`;
    } finally {
        await sql.end();
    }
}

export const mochaHooks: Mocha.RootHookObject = {
    async beforeAll(this: Mocha.Context): Promise<void> {
        this.timeout(HOOK_TIMEOUT_MS);

        // A suffix rather than a fixed name: runs from different trees go into one Postgres at the
        // same time.
        const name = `telegram_bot_test_${randomBytes(6).toString("hex")}`;

        await createDatabase(name);

        // Before the migrations: failed migrations would leave the database behind, and afterAll
        // drops only the one it remembers.
        databaseName = name;
        process.env[TEST_DATABASE_NAME] = name;

        await migrate(name);
    },

    async afterAll(this: Mocha.Context): Promise<void> {
        if (databaseName === undefined) {
            return;
        }

        this.timeout(HOOK_TIMEOUT_MS);

        const name = databaseName;

        databaseName = undefined;
        delete process.env[TEST_DATABASE_NAME];

        await dropDatabase(name);
    },
};
