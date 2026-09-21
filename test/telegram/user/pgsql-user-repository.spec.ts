import "reflect-metadata";
import { expect } from "chai";
import dayjs from "dayjs";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import { PgSqlUserRepository } from "app/telegram/user/pgsql-repository/pgsql-user-repository";
import { User } from "app/telegram/user/user";
import { UserNotFound } from "app/telegram/user/user.errors";
import type { UserDto } from "app/telegram/user/user.types";
import { testDatabaseName } from "test/database.helper";

// Larger than 2^31 - 1: it does not fit into int4, so the spec holds the migration that
// widened id to bigint as well. deep.equal is strict, so an id that came back as a string
// (that is how the driver returns bigint) will not pass.
const ID = 5_000_000_000;

describe("PgSqlUserRepository", function () {
    let database: Database;
    let repository: PgSqlUserRepository;

    before(async function () {
        const env = await new ConfigEnvStorage().load();
        // The config requires BOT_TOKEN while the spec needs only the database: without
        // the substitution it would depend on the token in .env.
        const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

        database = new Database({ ...settings, database: testDatabaseName() }, false);
        repository = new PgSqlUserRepository(database);
    });

    beforeEach(async function () {
        await database.sql`truncate users`;
    });

    after(async function () {
        // A failed before does not get to assign database, and a failure in after would hide its cause.
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

    // The upsert updates the columns listed in update set; created_time is not in the list.
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

// Everything in User is in private fields, so deep.equal compares a snapshot of the getters and not the object itself.
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
