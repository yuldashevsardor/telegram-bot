import { expect } from "chai";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import { replyContext, supportedFormats } from "test/telegram/handler.helper";

// The longest callback data Telegram takes.
const MAX_CALLBACK_DATA_BYTES = 64;

async function buttons(sourceExtension: Extension, locale?: "ru" | "en"): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const { ctx } = await replyContext({}, locale);

    return new FormatButtons(supportedFormats).build(ctx, sourceExtension).inline_keyboard as Array<
        Array<{ text: string; callback_data: string }>
    >;
}

describe("FormatButtons", function () {
    it("offers the formats but the source, three to a row, and all formats on a row of its own", async function () {
        const keyboard = await buttons(Extension.WOFF);

        expect(keyboard.map((row) => row.map((button) => button.text))).to.deep.equal([
            ["TTF", "OTF", "WOFF2"],
            ["EOT", "SVG"],
            ["Все форматы"],
        ]);
    });

    it("names the target alone in the callback data", async function () {
        const keyboard = await buttons(Extension.SVG);

        expect(keyboard.flat().map((button) => button.callback_data)).to.deep.equal([
            "convert:ttf",
            "convert:otf",
            "convert:woff",
            "convert:woff2",
            "convert:eot",
            "convert:all",
        ]);
    });

    it("keeps every callback data within the limit of Telegram", async function () {
        for (const sourceExtension of Object.values(Extension)) {
            for (const button of (await buttons(sourceExtension)).flat()) {
                expect(Buffer.byteLength(button.callback_data), button.callback_data).to.be.at.most(MAX_CALLBACK_DATA_BYTES);
            }
        }
    });

    it("names all formats in the locale of the update", async function () {
        const keyboard = await buttons(Extension.TTF, "en");

        expect(keyboard.at(-1)?.map((button) => button.text)).to.deep.equal(["All formats"]);
    });
});
