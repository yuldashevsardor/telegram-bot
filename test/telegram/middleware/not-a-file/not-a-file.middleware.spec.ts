import "reflect-metadata";
import { expect } from "chai";
import type { Animation, Document, Message, Sticker, Story, Voice } from "@grammyjs/types";
import { NotAFileMiddleware } from "app/telegram/middleware/not-a-file/not-a-file.middleware";
import type { Locale } from "app/telegram/locale/locale.types";
import type { HandlerRun } from "test/telegram/reply-context.helper";
import { runHandler, supportedFormats } from "test/telegram/reply-context.helper";

const DOCUMENT: Document = { file_id: "file-id", file_unique_id: "file-unique-id", file_name: "font.ttf" };

function run(content: Partial<Message>, locale?: Locale): Promise<HandlerRun> {
    return runHandler(new NotAFileMiddleware(supportedFormats), content, locale);
}

describe("NotAFileMiddleware", function () {
    it("asks for a file in reply to a text", async function () {
        const { replies, isPassedOn } = await run({ text: "hello" });

        expect(replies).to.deep.equal(["Пришлите шрифт файлом — TTF, OTF, WOFF, WOFF2, EOT, SVG."]);
        expect(isPassedOn).to.equal(false);
    });

    it("asks for a file in reply to a photo, a sticker, a voice and a forwarded story", async function () {
        const contents: Partial<Message>[] = [{ photo: [] }, { sticker: {} as Sticker }, { voice: {} as Voice }, { story: {} as Story }];

        for (const content of contents) {
            const { replies } = await run(content);

            expect(replies, Object.keys(content).join()).to.have.lengthOf(1);
        }
    });

    // Telegram puts a GIF into document as well, for backward compatibility.
    it("asks for a file in reply to a GIF, though it carries a document", async function () {
        const { replies } = await run({ animation: {} as Animation, document: DOCUMENT });

        expect(replies).to.have.lengthOf(1);
    });

    it("asks in the locale of the update", async function () {
        const { replies } = await run({ text: "hello" }, "en");

        expect(replies).to.deep.equal(["Send the font as a file: TTF, OTF, WOFF, WOFF2, EOT, SVG."]);
    });

    it("passes a document on without an answer", async function () {
        const { replies, isPassedOn } = await run({ document: DOCUMENT });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    it("passes a service message on without an answer", async function () {
        const { replies, isPassedOn } = await run({ write_access_allowed: {} });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });
});
