import "reflect-metadata";
import { expect } from "chai";
import type { Message, Sticker, Voice } from "@grammyjs/types";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { SupportedFormats } from "app/telegram/supported-formats";
import { NotAFileMiddleware } from "app/telegram/middleware/not-a-file/not-a-file.middleware";
import type { Locale } from "app/telegram/locale/locale.types";
import { replyContext } from "test/telegram/reply-context.helper";

const supportedFormats = { toText: (): string => "TTF, OTF, WOFF, WOFF2, EOT, SVG" } as SupportedFormats;

async function run(content: Partial<Message>, locale?: Locale): Promise<{ replies: string[]; passed: boolean }> {
    const { ctx, replies } = await replyContext(content, locale);
    const composer = new Composer<Context>();
    new NotAFileMiddleware(supportedFormats).setup(composer);
    let passed = false;

    await composer.middleware()(ctx, async () => {
        passed = true;
    });

    return { replies: replies, passed: passed };
}

describe("NotAFileMiddleware", function () {
    it("asks for a file in reply to a text", async function () {
        const { replies, passed } = await run({ text: "hello" });

        expect(replies).to.deep.equal(["Пришлите шрифт файлом — TTF, OTF, WOFF, WOFF2, EOT, SVG."]);
        expect(passed).to.equal(false);
    });

    it("asks for a file in reply to a photo, a sticker and a voice", async function () {
        const contents: Partial<Message>[] = [{ photo: [] }, { sticker: {} as Sticker }, { voice: {} as Voice }];

        for (const content of contents) {
            const { replies } = await run(content);

            expect(replies, Object.keys(content).join()).to.have.lengthOf(1);
        }
    });

    it("asks in the locale of the update", async function () {
        const { replies } = await run({ text: "hello" }, "en");

        expect(replies).to.deep.equal(["Send the font as a file: TTF, OTF, WOFF, WOFF2, EOT, SVG."]);
    });

    it("passes a document on without an answer", async function () {
        const { replies, passed } = await run({
            document: { file_id: "file-id", file_unique_id: "file-unique-id", file_name: "font.ttf" },
        });

        expect(replies).to.deep.equal([]);
        expect(passed).to.equal(true);
    });
});
