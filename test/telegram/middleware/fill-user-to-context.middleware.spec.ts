import "reflect-metadata";
import { expect } from "chai";
import dayjs from "dayjs";
import { Composer } from "grammy";
import { User } from "app/telegram/user/user";
import type { UserRepository } from "app/telegram/user/user.repository";
import type { UserService } from "app/telegram/user/user.service";
import type { Context } from "app/telegram/bot.types";
import { FillUserToContextMiddleware } from "app/telegram/middleware/fill-user-to-context.middleware";

const FROM = { id: 42, is_bot: false, first_name: "Sardor" };

describe("FillUserToContextMiddleware", function () {
    it("gives out the user of the current update", async function () {
        const existing = buildUser();
        const ctx = await run(existing, true);

        expect(ctx.getUser()).to.equal(existing);
    });

    it("gives out the user it has just created", async function () {
        const created = buildUser();
        const ctx = await run(created, false);

        expect(ctx.getUser()).to.equal(created);
    });

    // Перечислимые свойства контекста плагин разговоров клонирует в op-лог и в sessions,
    // а клон User — пустой объект. Функцию он не клонирует, а восстанавливает биндом от
    // живого контекста, поэтому пользователь остаётся доступен и внутри разговора.
    it("keeps the user out of the enumerable context properties", async function () {
        const ctx = await run(buildUser(), true);

        expect(Object.keys(ctx)).to.not.include("user");
        expect(Object.keys(ctx)).to.include("getUser");
        expect(ctx.getUser).to.be.a("function");
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

async function run(user: User, exists: boolean): Promise<Context> {
    const repository = { existsById: () => Promise.resolve(exists) } as unknown as UserRepository;
    const service = {
        edit: () => Promise.resolve(user),
        create: () => Promise.resolve(user),
    } as unknown as UserService;

    const composer = new Composer<Context>();
    new FillUserToContextMiddleware(service, repository).setup(composer);

    const ctx = { from: FROM, update: { update_id: 1 } } as unknown as Context;
    await composer.middleware()(ctx, () => Promise.resolve());

    return ctx;
}
