import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { runner } from "node-pg-migrate";
import postgres from "postgres";
import type { Sql } from "app/platform/database/database";
import { RuntimeError } from "app/shared/errors";

// Корневой хук mocha (.mocharc.json): база на прогон внутри общего Postgres из
// docker-compose.db.yml. Почему так, а не транзакция с откатом или testcontainers, —
// docs/architecture/testing.md, «База для тестов».
//
// Имя базы уходит спекам через TEST_DATABASE_NAME, а не подменой DATABASE_NAME: хук
// подключён в .mocharc.json, который живёт в образе, и в устаревшем образе он не встанет.
// Спека без своей переменной падает, а с подменённой DATABASE_NAME молча чистила бы общую
// базу работающих ботов.

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

// Суперпользователь только создаёт и удаляет базу. Спеки и миграции ходят в неё
// пользователем приложения, как бот: так таблицы принадлежат ему же, и права проверяются
// те же, что в проде.
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
    const sql = connectAsSuperuser();

    try {
        await sql`create database ${sql(name)} with owner ${sql(env("DATABASE_USER_NAME"))}`;
    } catch (error) {
        throw new RuntimeError("Could not create the test database: is PostgreSQL up (make db-up)?", { cause: error });
    } finally {
        await sql.end();
    }
}

// Каталог и таблица миграций — из migrate.json, как у node-pg-migrate в контейнере перед
// стартом бота: база прогона собирается тем же набором, что и рабочая.
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
        // force рвёт соединения, которые спека не закрыла: без него drop упал бы, и база
        // осталась бы висеть в общем Postgres.
        await sql`drop database ${sql(name)} with (force)`;
    } finally {
        await sql.end();
    }
}

export const mochaHooks: Mocha.RootHookObject = {
    async beforeAll(this: Mocha.Context): Promise<void> {
        this.timeout(HOOK_TIMEOUT_MS);

        // Суффикс, а не фиксированное имя: прогоны из разных деревьев идут в один Postgres
        // одновременно.
        const name = `telegram_bot_test_${randomBytes(6).toString("hex")}`;

        await createDatabase(name);

        // До миграций: упавшие миграции оставили бы базу, а afterAll удаляет только
        // запомненную.
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
