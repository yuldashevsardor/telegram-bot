import "reflect-metadata";
import { expect } from "chai";
import { HelpText } from "app/telegram/command/help/help-text";
import { helpText, replyContext, supportedFormats } from "test/telegram/handler.helper";

describe("HelpText", function () {
    it("builds the help of the customer journey", async function () {
        const { ctx } = await replyContext({ text: "/help" });

        expect(helpText.build(ctx)).to.equal(
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
        );
    });

    it("builds the help in the locale of the update", async function () {
        const { ctx } = await replyContext({ text: "/help" }, "en");

        expect(helpText.build(ctx)).to.equal(
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

    // The limit is a setting: a local Bot API server downloads larger files than the cloud one.
    it("names the size limit it is given", async function () {
        const { ctx } = await replyContext({ text: "/help" });

        expect(new HelpText(supportedFormats, "@author", 50).build(ctx)).to.include("Размер файла — до 50 МБ.");
    });
});
