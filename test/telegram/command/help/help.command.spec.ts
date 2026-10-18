import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { HelpCommand } from "app/telegram/command/help/help.command";
import { createFluent } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { command, replyContext } from "test/telegram/reply-context.helper";

const supportedFormats = { toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG" } as SupportedFormats;

// The update goes through setup(), as in Bot: the command has to answer to its own name.
async function help(locale?: Locale): Promise<string[]> {
    const { ctx, replies } = await replyContext(command("/help"), locale);
    const composer = new Composer<Context>();
    new HelpCommand(supportedFormats, "@author").setup(composer);

    await composer.middleware()(ctx, () => Promise.resolve());

    return replies;
}

describe("HelpCommand", function () {
    it("replies with the help of the customer journey on /help", async function () {
        expect(await help()).to.deep.equal([
            [
                "Как пользоваться:",
                "1. Пришлите файл шрифта.",
                "2. Выберите формат на кнопках.",
                "3. Получите файл.",
                "",
                "Форматы: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "Размер файла — до 20 МБ.",
                "Несколько файлов можно прислать сразу: отвечу на каждый.",
                "",
                "Вопросы и ошибки: @author.",
            ].join("\n"),
        ]);
    });

    it("replies in the locale of the update", async function () {
        const [text] = await help("en");

        expect(text).to.equal(
            [
                "How to use:",
                "1. Send a font file.",
                "2. Pick a format on the buttons.",
                "3. Get the file.",
                "",
                "Formats: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "File size: up to 20 MB.",
                "You can send several files at once: I will answer each of them.",
                "",
                "Questions and bugs: @author.",
            ].join("\n"),
        );
    });

    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new HelpCommand(supportedFormats, "@author");

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
