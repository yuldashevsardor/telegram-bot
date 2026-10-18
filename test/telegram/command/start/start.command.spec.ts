import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { StartCommand } from "app/telegram/command/start/start.command";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import { command, runHandler, supportedFormats } from "test/telegram/reply-context.helper";

describe("StartCommand", function () {
    it("replies with the welcome of the customer journey on /start", async function () {
        const { replies, isPassedOn } = await runHandler(new StartCommand(supportedFormats), command("/start"));

        expect(replies).to.deep.equal([
            [
                "Пришлите файл шрифта — сконвертирую его в другой формат.",
                "Форматы: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "Можно прислать несколько файлов сразу: отвечу на каждый.",
            ].join("\n"),
        ]);
        expect(isPassedOn).to.equal(false);
    });

    it("replies in the locale of the update", async function () {
        const { replies } = await runHandler(new StartCommand(supportedFormats), command("/start"), "en");

        expect(replies).to.deep.equal([
            [
                "Send me a font file, and I will convert it into another format.",
                "Formats: TTF, OTF, WOFF, WOFF2, EOT, SVG.",
                "You can send several files at once: I will answer each of them.",
            ].join("\n"),
        ]);
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
