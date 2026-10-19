import { expect } from "chai";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { FormatButtons } from "app/telegram/format-buttons/format-buttons";
import type { FormatMark } from "app/telegram/format-buttons/format-buttons.types";
import { FormatButtonCommand } from "app/telegram/format-buttons/format-buttons.types";
import { replyContext, supportedFormats } from "test/telegram/handler.helper";

// The longest callback data Telegram takes.
const MAX_CALLBACK_DATA_BYTES = 64;

const formatButtons = new FormatButtons(supportedFormats);

async function buttons(sourceExtension: Extension, locale?: "ru" | "en"): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const { ctx } = await replyContext({}, locale);

    return formatButtons.build(ctx, sourceExtension).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
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

    // docs/product/cjm.md, step 4.
    describe("marks", function () {
        async function questionKeyboard(): Promise<InlineKeyboardMarkup> {
            return { inline_keyboard: await buttons(Extension.WOFF) };
        }

        // The question after a press with the marks given.
        async function markedQuestion(marks: Map<Extension, FormatMark>): Promise<InlineKeyboardMarkup> {
            const markedKeyboard = formatButtons.mark(await questionKeyboard(), marks);

            if (markedKeyboard === undefined) {
                return expect.fail("The keyboard was expected to change");
            }

            return markedKeyboard;
        }

        function looks(keyboard: InlineKeyboardMarkup | undefined): unknown {
            return keyboard?.inline_keyboard.map((row) => row.map((button) => button.text));
        }

        function callbackData(keyboard: InlineKeyboardMarkup | undefined): Array<Array<string | undefined>> | undefined {
            return keyboard?.inline_keyboard.map((row) =>
                row.map((button) => ("callback_data" in button ? button.callback_data : undefined)),
            );
        }

        it("marks a format sent with a tick and one failed with a cross, leaving the other buttons as they were", async function () {
            const marks = new Map<Extension, FormatMark>([
                [Extension.TTF, FormatButtonCommand.Sent],
                [Extension.SVG, FormatButtonCommand.Failed],
            ]);

            const markedKeyboard = formatButtons.mark(await questionKeyboard(), marks);

            expect(looks(markedKeyboard)).to.deep.equal([["✓ TTF", "OTF", "WOFF2"], ["EOT", "✗ SVG"], ["Все форматы"]]);
            expect(callbackData(markedKeyboard)).to.deep.equal([
                ["sent:ttf", "convert:otf", "convert:woff2"],
                ["convert:eot", "failed:svg"],
                ["convert:all"],
            ]);
        });

        it("keeps the marks of earlier presses", async function () {
            const keyboard = await markedQuestion(new Map([[Extension.TTF, FormatButtonCommand.Sent]]));

            const markedKeyboard = formatButtons.mark(keyboard, new Map([[Extension.EOT, FormatButtonCommand.Failed]]));

            expect(looks(markedKeyboard)).to.deep.equal([["✓ TTF", "OTF", "WOFF2"], ["✗ EOT", "SVG"], ["Все форматы"]]);
        });

        it("marks a format anew by the outcome of the press", async function () {
            const keyboard = await markedQuestion(new Map([[Extension.TTF, FormatButtonCommand.Failed]]));

            const markedKeyboard = formatButtons.mark(keyboard, new Map([[Extension.TTF, FormatButtonCommand.Sent]]));

            expect(looks(markedKeyboard)).to.deep.equal([["✓ TTF", "OTF", "WOFF2"], ["EOT", "SVG"], ["Все форматы"]]);
            expect(callbackData(markedKeyboard)?.[0]?.[0]).to.equal("sent:ttf");
        });

        // Telegram refuses an edit that changes nothing.
        it("gives nothing when no button changes", async function () {
            const keyboard = await markedQuestion(new Map([[Extension.TTF, FormatButtonCommand.Sent]]));

            expect(formatButtons.mark(keyboard, new Map([[Extension.TTF, FormatButtonCommand.Sent]]))).to.equal(undefined);
            expect(formatButtons.mark(await questionKeyboard(), new Map())).to.equal(undefined);
        });

        it("keeps the data of every marked button within the limit of Telegram", async function () {
            const allMarks: FormatMark[] = [FormatButtonCommand.Sent, FormatButtonCommand.Failed];

            for (const mark of allMarks) {
                const marks = new Map(Object.values(Extension).map((extension) => [extension, mark]));

                for (const sourceExtension of Object.values(Extension)) {
                    const markedKeyboard = formatButtons.mark({ inline_keyboard: await buttons(sourceExtension) }, marks);

                    for (const data of (callbackData(markedKeyboard) as string[][]).flat()) {
                        expect(Buffer.byteLength(data), data).to.be.at.most(MAX_CALLBACK_DATA_BYTES);
                    }
                }
            }
        });

        it("finds the command and the format of the data of a format button", function () {
            expect(formatButtons.parse("convert:all")).to.deep.equal({ command: FormatButtonCommand.Convert, format: "all" });
            expect(formatButtons.parse("sent:ttf")).to.deep.equal({ command: FormatButtonCommand.Sent, format: "ttf" });
            expect(formatButtons.parse("failed:woff2")).to.deep.equal({ command: FormatButtonCommand.Failed, format: "woff2" });
        });

        it("finds no format button in data of another command or of another number of parts", function () {
            for (const data of ["other:ttf", "convert", "convert:ttf:more", ""]) {
                expect(formatButtons.parse(data), data).to.equal(undefined);
            }
        });

        it("finds the target of a format it knows alone", function () {
            expect(formatButtons.findTargetExtension({ command: FormatButtonCommand.Sent, format: "otf" })).to.equal(Extension.OTF);

            for (const format of ["all", "pdf", ""]) {
                expect(formatButtons.findTargetExtension({ command: FormatButtonCommand.Sent, format: format }), format).to.equal(
                    undefined,
                );
            }
        });
    });
});
