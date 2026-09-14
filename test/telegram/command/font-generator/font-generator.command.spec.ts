import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import type { FontConvertor } from "app/font-convertor/font-convertor";
import type { ConvertParams } from "app/font-convertor/font-convertor.types";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontGeneratorCommand } from "app/telegram/command/font-generator/font-generator.command";
import { createFluent } from "app/telegram/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale.types";

type ErrorRecord = { message: string; payload: UnknownObject | undefined };

type Run = { events: string[]; originPaths: string[]; errors: ErrorRecord[] };

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

async function run(failOn?: { extension: Extension; error: Error }): Promise<Run> {
    const result: Run = { events: [], originPaths: [], errors: [] };

    const convertor = {
        convert: async ({ originPath, extension }: ConvertParams): Promise<string> => {
            result.events.push(`convert ${extension}`);
            result.originPaths.push(originPath);

            if (failOn?.extension === extension) {
                throw failOn.error;
            }

            return `/result.${extension}`;
        },
    } as unknown as FontConvertor;

    const logger: Logger = {
        critical: () => undefined,
        error: (message: string, payload?: UnknownObject): void => {
            result.errors.push({ message: message, payload: payload });
        },
        warning: () => undefined,
        info: () => undefined,
        debug: () => undefined,
    };

    // Апдейт идёт через setup(), как в Bot: команда должна откликнуться на своё имя.
    const ctx = Object.assign(new GrammyContext(commandUpdate("/font_generator"), new Api("test-token"), ME), {
        t: (key: string, args?: Record<string, unknown>): string => `${key} ${String(args?.["path"])}`,
        reply: async (text: string): Promise<void> => {
            result.events.push(`reply ${text}`);
        },
    }) as unknown as Context;
    const composer = new Composer<Context>();
    new FontGeneratorCommand(convertor, logger, "/root").setup(composer);

    await composer.middleware()(ctx, () => Promise.resolve());

    return result;
}

describe("FontGeneratorCommand", function () {
    it("converts the fixture to EOT, OTF, TTF and WOFF2, replying after each", async function () {
        const { events, errors } = await run();

        expect(events).to.deep.equal([
            "convert eot",
            "reply font-generator-result /result.eot",
            "convert otf",
            "reply font-generator-result /result.otf",
            "convert ttf",
            "reply font-generator-result /result.ttf",
            "convert woff2",
            "reply font-generator-result /result.woff2",
        ]);
        expect(errors).to.have.lengthOf(0);
    });

    it("takes the WOFF fixture under the root directory", async function () {
        const { originPaths } = await run();

        expect(new Set(originPaths)).to.deep.equal(new Set(["/root/test/fixtures/fonts/test-font.woff"]));
    });

    // Ошибка пользователю не видна: команда отладочная, след остаётся только в логе.
    it("stops at the first failure and only logs it", async function () {
        const error = new Error("fontforge failed");

        const { events, errors } = await run({ extension: Extension.OTF, error: error });

        expect(events).to.deep.equal(["convert eot", "reply font-generator-result /result.eot", "convert otf"]);
        expect(errors).to.deep.equal([{ message: "Font generation is failed.", payload: { cause: error } }]);
    });

    // Описание в меню команд Bot берёт переводом descriptionKey; ключ без перевода Fluent отдал бы как «{ключ}».
    // Недостающий в другой локали ключ Fluent молча берёт из дефолтной, его ловит «declares the same keys
    // in every locale» в locale.spec.ts.
    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new FontGeneratorCommand({} as FontConvertor, {} as Logger, "/root");

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
