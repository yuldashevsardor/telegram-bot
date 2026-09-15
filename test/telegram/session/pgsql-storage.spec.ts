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
        // BOT_TOKEN конфиг требует, а спеке нужна только база: без подстановки она зависела бы от токена в .env.
        const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

        database = new Database({ ...settings, database: testDatabaseName() }, false);
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
