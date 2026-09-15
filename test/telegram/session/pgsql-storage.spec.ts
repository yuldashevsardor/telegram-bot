import "reflect-metadata";
import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config-container";
import { ConfigEnvStorage } from "app/platform/config/config-env-storage";
import { Database } from "app/platform/database/database";
import { RuntimeError } from "app/shared/errors";
import { PgsqlStorage } from "app/telegram/session/pgsql-storage";

const KEY = "42:42";

describe("PgsqlStorage", function () {
    let database: Database;
    let storage: PgsqlStorage;

    before(function () {
        const env = new ConfigEnvStorage();
        // BOT_TOKEN конфиг требует, а спеке нужна только база: без подстановки она зависела бы от токена в .env.
        const config = new ConfigContainer({ get: (key): string | undefined => (key === "BOT_TOKEN" ? "test-token" : env.get(key)) });

        database = new Database({ ...config.get("database"), database: testDatabaseName() }, false);
        storage = new PgsqlStorage(database);
    });

    beforeEach(async function () {
        await database.sql`truncate sessions`;
    });

    after(async function () {
        // Упавший before не успевает присвоить database, и падение after заслонило бы его причину.
        await database?.close();
    });

    it("reads nothing for a key that was never written", async function () {
        expect(await storage.read(KEY)).to.equal(undefined);
    });

    // Вставка позиционная: колонку, добавленную миграцией перед value, payload занял бы
    // вместо неё, и чтение вернуло бы null (docs/architecture/invariants.md).
    it("reads back the written payload", async function () {
        await storage.write(KEY, { requestCount: 1 });

        expect(await storage.read(KEY)).to.deep.equal({ requestCount: 1 });
    });

    it("replaces the payload of a key that is already written", async function () {
        await storage.write(KEY, { requestCount: 1 });
        await storage.write(KEY, { requestCount: 2 });

        expect(await storage.read(KEY)).to.deep.equal({ requestCount: 2 });
    });

    // now() — время начала транзакции, а у каждой записи она своя. Сравнивается в SQL:
    // Date теряет микросекунды, и записи в одну миллисекунду сравнялись бы.
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

// Базу прогона создаёт test/database-hook.ts; почему имя приходит своей переменной, а не
// DATABASE_NAME, — там же.
function testDatabaseName(): string {
    const name = process.env["TEST_DATABASE_NAME"];

    if (name === undefined) {
        throw new RuntimeError("TEST_DATABASE_NAME is not set: test/database-hook.ts did not run, rebuild the image (make rebuild)");
    }

    return name;
}
