import "reflect-metadata";
import { expect } from "chai";
import dayjs from "dayjs";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import { PgSqlUserRepository } from "app/telegram/user/pgsql-user-repository/pgsql-user-repository";
import { User } from "app/telegram/user/user";
import { UserNotFound } from "app/telegram/user/user.errors";
import type { UserDto } from "app/telegram/user/user.types";
import { testDatabaseName } from "test/database.helper";

// Больше 2^31 - 1: в int4 не влезает, так спека держит и миграцию, расширившую id до bigint.
// deep.equal строгий, поэтому id, вернувшийся строкой (так драйвер отдаёт bigint), не пройдёт.
const ID = 5_000_000_000;

describe("PgSqlUserRepository", function () {
    let database: Database;
    let repository: PgSqlUserRepository;

    before(async function () {
        const env = await new ConfigEnvStorage().load();
        // BOT_TOKEN конфиг требует, а спеке нужна только база: без подстановки она зависела бы от токена в .env.
        const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

        database = new Database({ ...settings, database: testDatabaseName() }, false);
        repository = new PgSqlUserRepository(database);
    });

    beforeEach(async function () {
        await database.sql`truncate users`;
    });

    after(async function () {
        // Упавший before не успевает присвоить database, и падение after заслонило бы его причину.
        await database?.close();
    });

    it("does not find a user that was never saved", async function () {
        expect(await repository.existsById(ID)).to.equal(false);

        try {
            await repository.getById(ID);
            expect.fail("getById() was expected to reject");
        } catch (error) {
            expect(error).to.be.instanceOf(UserNotFound);
            expect((error as UserNotFound).payload).to.deep.equal({ id: ID });
        }
    });

    it("reads back a saved user with every field", async function () {
        const user = buildUser();

        await repository.save(user);

        expect(await repository.existsById(ID)).to.equal(true);
        expect(snapshot(await repository.getById(ID))).to.deep.equal(snapshot(user));
    });

    // Upsert обновляет перечисленные в update set колонки; created_time в перечне нет.
    it("updates a saved user and keeps its created_time", async function () {
        const original = buildUser();

        await repository.save(original);

        const changed = buildUser({
            firstname: "Changed",
            lastname: "Changed",
            username: "changed",
            isBot: true,
            lastActiveTime: dayjs("2026-02-01T10:00:00.000Z"),
            createdTime: dayjs("2026-02-01T09:00:00.000Z"),
            updatedTime: dayjs("2026-02-01T11:00:00.000Z"),
        });

        await repository.save(changed);

        expect(snapshot(await repository.getById(ID))).to.deep.equal({
            ...snapshot(changed),
            createdTime: original.createdTime.toISOString(),
        });
    });

    it("deletes a saved user", async function () {
        await repository.save(buildUser());
        await repository.delete(ID);

        expect(await repository.existsById(ID)).to.equal(false);
    });
});

function buildUser(overrides: Partial<UserDto> = {}): User {
    return new User({
        id: ID,
        firstname: "Sardor",
        lastname: "Yuldashev",
        username: "sardor",
        isBot: false,
        lastActiveTime: dayjs("2026-01-01T10:00:00.000Z"),
        createdTime: dayjs("2026-01-01T09:00:00.000Z"),
        updatedTime: dayjs("2026-01-01T09:30:00.000Z"),
        ...overrides,
    });
}

// У User всё в приватных полях, поэтому deep.equal сравнивает снимок геттеров, а не сам объект.
function snapshot(user: User): Record<string, unknown> {
    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        username: user.username,
        isBot: user.isBot,
        lastActiveTime: user.lastActiveTime.toISOString(),
        createdTime: user.createdTime.toISOString(),
        updatedTime: user.updatedTime.toISOString(),
    };
}
