import "reflect-metadata";
import { expect } from "chai";
import dayjs from "dayjs";
import { Composer } from "grammy";
import type { User as TelegramUser } from "@grammyjs/types";
import { User } from "app/telegram/user/user";
import type { UserRepository } from "app/telegram/user/user-repository";
import type { UserService } from "app/telegram/user/service/user-service";
import type { CreateUserDto, EditUserDto } from "app/telegram/user/service/user-service.types";
import type { Context } from "app/telegram/bot/bot.types";
import { FillUserToContextMiddleware } from "app/telegram/middleware/fill-user-to-context.middleware";
import { UpdateWithoutFrom } from "app/telegram/bot/bot.errors";

const FROM: TelegramUser = { id: 42, is_bot: false, first_name: "Sardor" };
const FULL_FROM: TelegramUser = { ...FROM, last_name: "Lastname", username: "username" };

type Calls = { created: CreateUserDto[]; edited: Array<{ id: number; dto: EditUserDto }> };

describe("FillUserToContextMiddleware", function () {
    it("gives out the user of the current update", async function () {
        const existing = buildUser();
        const { ctx } = await run(existing, true);

        expect(ctx.getUser()).to.equal(existing);
    });

    it("gives out the user it has just created", async function () {
        const created = buildUser();
        const { ctx } = await run(created, false);

        expect(ctx.getUser()).to.equal(created);
    });

    // The conversations plugin clones the enumerable context properties into the op log and into
    // sessions, and a clone of User is an empty object. A function it does not clone but restores
    // by binding to the live context, so the user stays reachable inside a conversation as well.
    it("keeps the user out of the enumerable context properties", async function () {
        const { ctx } = await run(buildUser(), true);

        expect(Object.keys(ctx)).to.not.include("user");
        expect(Object.keys(ctx)).to.include("getUser");
        expect(ctx.getUser).to.be.a("function");
    });

    it("creates a new user from the update", async function () {
        const { calls } = await run(buildUser(), false, FULL_FROM);

        expect(calls.edited).to.have.lengthOf(0);
        expect(calls.created).to.deep.equal([{ id: 42, firstname: "Sardor", lastname: "Lastname", username: "username", isBot: false }]);
    });

    it("edits an existing user from the update and marks the activity", async function () {
        const before = dayjs();
        const { calls } = await run(buildUser(), true, FULL_FROM);

        expect(calls.created).to.have.lengthOf(0);
        expect(calls.edited).to.have.lengthOf(1);

        const { id, dto } = calls.edited[0] as { id: number; dto: EditUserDto };
        const { lastActiveTime, ...profile } = dto;

        expect(id).to.equal(42);
        expect(profile).to.deep.equal({ firstname: "Sardor", lastname: "Lastname", username: "username", isBot: false });
        expect(lastActiveTime?.isBefore(before)).to.equal(false);
    });

    // Telegram does not send last_name and username when the profile has none, while their columns
    // are mandatory: a missing field is written as an empty string.
    it("writes the missing optional names as empty strings", async function () {
        const created = await run(buildUser(), false, FROM);
        const edited = await run(buildUser(), true, FROM);

        expect(created.calls.created[0]).to.include({ lastname: "", username: "" });
        expect(edited.calls.edited[0]?.dto).to.include({ lastname: "", username: "" });
    });

    // Such an update is cut off by HasSessionKeyFilter higher up the pipeline: it gets here only
    // if the order in Bot.setup() is broken, and it must not pass on silently.
    it("rejects an update without from before touching the storage", async function () {
        let touched = false;
        const repository = {
            existsById: () => {
                touched = true;

                return Promise.resolve(false);
            },
        } as unknown as UserRepository;

        const composer = new Composer<Context>();
        new FillUserToContextMiddleware({} as UserService, repository).setup(composer);

        const caught = await Promise.resolve()
            .then(() => composer.middleware()({ update: { update_id: 7 } } as Context, () => Promise.resolve()))
            .then(
                () => undefined,
                (error: unknown) => error,
            );

        expect(caught).to.be.instanceOf(UpdateWithoutFrom);
        expect((caught as UpdateWithoutFrom).message).to.equal("Update without `from` reached the middleware chain.");
        expect((caught as UpdateWithoutFrom).payload).to.deep.equal({ updateId: 7 });
        expect(touched).to.equal(false);
    });
});

function buildUser(): User {
    return new User({
        id: FROM.id,
        firstname: FROM.first_name,
        lastname: "",
        username: "",
        isBot: FROM.is_bot,
        lastActiveTime: dayjs(),
        createdTime: dayjs(),
        updatedTime: dayjs(),
    });
}

async function run(user: User, exists: boolean, from: TelegramUser = FROM): Promise<{ ctx: Context; calls: Calls }> {
    const calls: Calls = { created: [], edited: [] };
    const repository = { existsById: () => Promise.resolve(exists) } as unknown as UserRepository;
    const service = {
        edit: (id: number, dto: EditUserDto) => {
            calls.edited.push({ id: id, dto: dto });

            return Promise.resolve(user);
        },
        create: (dto: CreateUserDto) => {
            calls.created.push(dto);

            return Promise.resolve(user);
        },
    } as unknown as UserService;

    const composer = new Composer<Context>();
    new FillUserToContextMiddleware(service, repository).setup(composer);

    const ctx = { from: from, update: { update_id: 1 } } as unknown as Context;
    await composer.middleware()(ctx, () => Promise.resolve());

    return { ctx: ctx, calls: calls };
}
