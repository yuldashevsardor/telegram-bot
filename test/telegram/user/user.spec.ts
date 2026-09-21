import { expect } from "chai";
import dayjs from "dayjs";
import { User } from "app/telegram/user/user";
import type { UserDto } from "app/telegram/user/user.types";

const DTO: UserDto = {
    id: 42,
    firstname: "Sardor",
    lastname: "Yuldashev",
    username: "sardor",
    isBot: false,
    lastActiveTime: dayjs("2020-01-01T10:00:00Z"),
    createdTime: dayjs("2020-01-01T09:00:00Z"),
    updatedTime: dayjs("2020-01-01T11:00:00Z"),
};

type EditableField = "firstname" | "lastname" | "username" | "isBot" | "lastActiveTime";

const CHANGES: { [K in EditableField]: UserDto[K] } = {
    firstname: "Ivan",
    lastname: "Petrov",
    username: "ivan",
    isBot: true,
    lastActiveTime: dayjs("2021-06-01T12:00:00Z"),
};

describe("User", function () {
    it("exposes the dto it was built from", function () {
        const user = new User(DTO);

        expect({
            id: user.id,
            firstname: user.firstname,
            lastname: user.lastname,
            username: user.username,
            isBot: user.isBot,
            lastActiveTime: user.lastActiveTime,
            createdTime: user.createdTime,
            updatedTime: user.updatedTime,
        }).to.deep.equal(DTO);
    });

    for (const field of Object.keys(CHANGES) as EditableField[]) {
        it(`bumps updatedTime when ${field} is set`, function () {
            const user = new User(DTO);
            const before = dayjs();

            Reflect.set(user, field, CHANGES[field]);

            expect(user[field]).to.equal(CHANGES[field]);
            expect(user.updatedTime.isBefore(before), "updatedTime stayed the same").to.be.false;
            expect(user.createdTime).to.equal(DTO.createdTime);
        });
    }
});
