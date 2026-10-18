import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { StartCommand } from "app/telegram/command/start/start.command";
import { createFluent } from "app/telegram/locale/locale";
import type { Locale } from "app/telegram/locale/locale.types";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { command, replyContext } from "test/telegram/reply-context.helper";

const supportedFormats = { toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG" } as SupportedFormats;

// The update goes through setup(), as in Bot: the command has to answer to its own name.
async function start(locale?: Locale): Promise<string[]> {
    const { ctx, replies } = await replyContext(command("/start"), locale);
    const composer = new Composer<Context>();
    new StartCommand(supportedFormats).setup(composer);

    await composer.middleware()(ctx, () => Promise.resolve());

    return replies;
}

describe("StartCommand", function () {
    it("replies with the welcome of the customer journey on /start", async function () {
        expect(await start()).to.deep.equal([
            [
                "Пришлите файл шрифта — сконвертирую его в другой формат.",
                "Форматы: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "Можно прислать несколько файлов сразу: отвечу на каждый.",
            ].join("\n"),
        ]);
    });

    it("replies in the locale of the update", async function () {
        const [welcome] = await start("en");

        expect(welcome).to.equal(
            [
                "Send me a font file, and I will convert it into another format.",
                "Formats: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "You can send several files at once: I will answer each of them.",
            ].join("\n"),
        );
    });

    // Bot translates descriptionKey for the command menu, and Fluent gives back `{key}` for a key
    // without a translation. A key missing in one locale only: locale.spec.ts, "declares the same
    // keys in every locale".
    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new StartCommand(supportedFormats);

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
