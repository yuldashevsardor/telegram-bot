import "reflect-metadata";
import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import type { ConfigStorage } from "app/platform/config/config-storage";
import { Database } from "app/platform/database/database";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { RuntimeError } from "app/shared/errors";

type ContextParts = {
    config: ConfigContainer | null;
};

// Окружение контейнера, в котором DATABASE_NAME заменено базой прогона. Её создаёт
// test/database-hook.ts; почему имя приходит своей переменной — там же. BOT_TOKEN конфиг
// требует, а базе он не нужен: без подстановки спека зависела бы от токена в .env.
class TestDatabaseStorage implements ConfigStorage {
    public get(key: string): string | undefined {
        if (key === "BOT_TOKEN") {
            return "test-token";
        }

        return key === "DATABASE_NAME" ? testDatabaseName() : process.env[key];
    }
}

// Как в container.spec.ts: поле обнуляется сразу после конструктора, иначе заполненный
// контекст молча отдал бы этот конфиг configValue() в чужих спеках.
const context = ApplicationContext as unknown as ContextParts;

describe("Database", function () {
    it("connects with the settings from the config by default", async function () {
        context.config = new ConfigContainer(new TestDatabaseStorage());

        let database: Database;

        try {
            database = new Database();
        } finally {
            context.config = null;
        }

        try {
            const [row] = await database.sql<{ name: string }[]>`select current_database() as name`;

            expect(row?.name).to.equal(testDatabaseName());
        } finally {
            await database.close();
        }
    });

    // Поэтому Application.setup() и зовёт check(): без него недоступная база всплыла бы
    // только на первом апдейте.
    it("does not connect until the first query", async function () {
        const database = new Database({ ...settings(), database: `${testDatabaseName()}_missing` }, false);

        try {
            await database.check();
            expect.fail("check() was expected to reject");
        } catch (error) {
            // 3D000 — invalid_catalog_name: база не существует.
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

    // Утверждение storage.md: debug у postgres ничего не печатает, а только делает поля
    // ошибки запроса перечислимыми — так они доходят до payload лога.
    it("exposes the failed query as enumerable fields outside production", async function () {
        expect(await failedQueryKeys(false)).to.include.members(["query", "parameters"]);
    });

    it("keeps the failed query out of the enumerable fields in production", async function () {
        const keys = await failedQueryKeys(true);

        // По одному полю: not.include.members значит «не надмножество» и прошёл бы, будь
        // скрыто хотя бы одно из двух.
        expect(keys).to.not.include("query");
        expect(keys).to.not.include("parameters");
    });
});

function testDatabaseName(): string {
    const name = process.env["TEST_DATABASE_NAME"];

    if (name === undefined) {
        throw new RuntimeError("TEST_DATABASE_NAME is not set: test/database-hook.ts did not run, rebuild the image (make rebuild)");
    }

    return name;
}

function settings(): DatabaseSettings {
    return new ConfigContainer(new TestDatabaseStorage()).database;
}

async function failedQueryKeys(isProduction: boolean): Promise<string[]> {
    const database = new Database(settings(), isProduction);

    try {
        await database.sql`select * from missing_table where id = ${1}`;
        expect.fail("the query was expected to reject");
    } catch (error) {
        // 42P01 — undefined_table; заодно отсекает AssertionError от expect.fail выше.
        expect(error).to.have.property("code", "42P01");

        return Object.keys(error as object);
    } finally {
        await database.close();
    }
}
