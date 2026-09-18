import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot.types";
import type { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { StartCommand } from "app/telegram/command/start/start.command";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

function commandUpdate(text: string): Update {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, is_bot: false, first_name: "User" },
            text: text,
            entities: [{ type: "bot_command", offset: 0, length: text.length }],
        },
    };
}

describe("StartCommand", function () {
    // Апдейт идёт через setup(), как в Bot: команда должна откликнуться на своё имя.
    it("enters the start conversation with the update context on /start", async function () {
        const entered: Context[] = [];
        const startConversation = {
            enter: async (ctx: Context): Promise<void> => {
                entered.push(ctx);
            },
        } as unknown as StartConversation;
        const ctx = new GrammyContext(commandUpdate("/start"), new Api("test-token"), ME) as Context;
        const composer = new Composer<Context>();
        new StartCommand(startConversation).setup(composer);

        await composer.middleware()(ctx, () => Promise.resolve());

        expect(entered).to.have.lengthOf(1);
        expect(entered[0]).to.equal(ctx);
    });

    // Описание в меню команд Bot берёт переводом descriptionKey; ключ без перевода Fluent отдал бы как «{ключ}».
    // Недостающий в другой локали ключ Fluent молча берёт из дефолтной, его ловит «declares the same keys
    // in every locale» в locale.spec.ts.
    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new StartCommand({} as StartConversation);

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
