import "reflect-metadata";
import { expect } from "chai";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { User } from "app/telegram/user/user";
import { UserNotFound } from "app/telegram/user/user.errors";
import { UserCreateError, UserEditError } from "app/telegram/user/service/user-service.errors";
import type { UserRepository } from "app/telegram/user/user-repository";
import { UserService } from "app/telegram/user/service/user-service";
import type { CreateUserDto, EditUserDto } from "app/telegram/user/service/user-service.types";
import type { UserDto } from "app/telegram/user/user.types";

const PROFILE: CreateUserDto = { id: 42, firstname: "Sardor", lastname: "Yuldashev", username: "sardor", isBot: false };

const STORED: UserDto = {
    ...PROFILE,
    lastActiveTime: dayjs("2020-01-01T10:00:00Z"),
    createdTime: dayjs("2020-01-01T09:00:00Z"),
    updatedTime: dayjs("2020-01-01T11:00:00Z"),
};

// The repository keeps a snapshot of the fields, not the object itself, as a database row does.
// Otherwise getById() would show an edit of an instance without save(), and the test could not
// tell the two apart.
class InMemoryUserRepository implements UserRepository {
    private readonly rows = new Map<number, UserDto>();

    public failSaveWith: Error | undefined;

    public getById(id: number): Promise<User> {
        const row = this.rows.get(id);

        return row === undefined ? Promise.reject(UserNotFound.byId(id)) : Promise.resolve(new User(row));
    }

    public existsById(id: number): Promise<boolean> {
        return Promise.resolve(this.rows.has(id));
    }

    public save(user: User): Promise<void> {
        if (this.failSaveWith !== undefined) {
            return Promise.reject(this.failSaveWith);
        }

        this.rows.set(user.id, toDto(user));

        return Promise.resolve();
    }

    public delete(id: number): Promise<void> {
        this.rows.delete(id);

        return Promise.resolve();
    }
}

describe("UserService", function () {
    let repository: InMemoryUserRepository;
    let service: UserService;

    beforeEach(function () {
        repository = new InMemoryUserRepository();
        service = new UserService(repository);
    });

    describe("create", function () {
        it("saves the profile with every time set to now and returns the saved user", async function () {
            const before = dayjs();
            const user = await service.create(PROFILE);
            const after = dayjs();

            const saved = toDto(await repository.getById(PROFILE.id));

            expect(saved).to.deep.include(PROFILE);
            expectBetween(saved.lastActiveTime, before, after);
            expectBetween(saved.createdTime, before, after);
            expectBetween(saved.updatedTime, before, after);
            expect(toDto(user)).to.deep.equal(saved);
        });

        it("wraps a failed save into UserCreateError with the dto and the original error", async function () {
            const failure = new Error("connection lost");
            repository.failSaveWith = failure;

            const error = await rejectionOf(() => service.create(PROFILE));

            expect(error).to.be.instanceOf(UserCreateError);
            expect((error as UserCreateError).message).to.equal("Error in create user");
            expect((error as UserCreateError).payload).to.deep.equal({ dto: PROFILE });
            expect((error as UserCreateError).cause).to.equal(failure);
        });
    });

    describe("edit", function () {
        beforeEach(async function () {
            await repository.save(new User(STORED));
        });

        it("saves every passed field and bumps updatedTime", async function () {
            const dto: Required<EditUserDto> = {
                firstname: "Ivan",
                lastname: "Petrov",
                username: "ivan",
                isBot: true,
                lastActiveTime: dayjs("2021-06-01T12:00:00Z"),
            };

            const before = dayjs();
            const user = await service.edit(STORED.id, dto);

            const saved = toDto(await repository.getById(STORED.id));

            expect(saved).to.deep.include({ id: STORED.id, ...dto, createdTime: STORED.createdTime });
            expect(saved.updatedTime.isBefore(before), "updatedTime stayed the same").to.be.false;
            expect(toDto(user)).to.deep.equal(saved);
        });

        // FillUserToContextMiddleware normally passes "" for a missing lastname and username,
        // and false in isBot. A truthiness check instead of !== undefined would leave the
        // previous values in the database.
        it("saves empty strings and false over the stored values", async function () {
            await repository.save(new User({ ...STORED, isBot: true }));
            const dto: EditUserDto = { firstname: "", lastname: "", username: "", isBot: false };

            await service.edit(STORED.id, dto);

            expect(toDto(await repository.getById(STORED.id))).to.deep.include(dto);
        });

        it("keeps the stored user as it was when nothing is passed", async function () {
            await service.edit(STORED.id, {});

            expect(toDto(await repository.getById(STORED.id))).to.deep.equal(STORED);
        });

        it("wraps a failed save into UserEditError with the dto and the original error", async function () {
            const failure = new Error("connection lost");
            const dto: EditUserDto = { username: "ivan" };
            repository.failSaveWith = failure;

            const error = await rejectionOf(() => service.edit(STORED.id, dto));

            expect(error).to.be.instanceOf(UserEditError);
            expect((error as UserEditError).message).to.equal("Error in edit user");
            expect((error as UserEditError).payload).to.deep.equal({ dto: dto });
            expect((error as UserEditError).cause).to.equal(failure);
        });

        it("lets UserNotFound through unwrapped when there is no such user", async function () {
            const missingId = STORED.id + 1;

            const error = await rejectionOf(() => service.edit(missingId, { username: "ivan" }));

            expect(error).to.be.instanceOf(UserNotFound);
            expect((error as UserNotFound).message).to.equal(`User with id ${missingId} not found.`);
            expect((error as UserNotFound).payload).to.deep.equal({ id: missingId });
        });
    });
});

function toDto(user: User): UserDto {
    return {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        username: user.username,
        isBot: user.isBot,
        lastActiveTime: user.lastActiveTime,
        createdTime: user.createdTime,
        updatedTime: user.updatedTime,
    };
}

// A call that did not throw fails with the "call did not throw" message. Thrown inside a try,
// the AssertionError would be caught by its own catch and read as an error of the wrong class.
function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
    return call().then(
        () => expect.fail("call did not throw"),
        (error: unknown) => error,
    );
}

function expectBetween(time: Dayjs, from: Dayjs, to: Dayjs): void {
    expect(time.isBefore(from) || time.isAfter(to), `${time.toISOString()} not in ${from.toISOString()}..${to.toISOString()}`).to.be.false;
}
