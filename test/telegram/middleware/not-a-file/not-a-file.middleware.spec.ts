import "reflect-metadata";
import { expect } from "chai";
import type { Animation, Document, GiveawayWinners, Message, Sticker, Story, Voice } from "@grammyjs/types";
import { NotAFileMiddleware } from "app/telegram/middleware/not-a-file/not-a-file.middleware";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import type { Locale } from "app/telegram/locale/locale.types";
import { initialPayload } from "app/telegram/session/session.helper";
import type { SessionPayload } from "app/telegram/session/session.types";
import type { HandlerRun } from "test/telegram/handler.helper";
import { runHandler, supportedFormatsWithEotOnlyTarget } from "test/telegram/handler.helper";

const DOCUMENT: Document = { file_id: "file-id", file_unique_id: "file-unique-id", file_name: "font.ttf" };

function run(content: Partial<Message>, locale?: Locale, session?: SessionPayload): Promise<HandlerRun> {
    return runHandler(new NotAFileMiddleware(supportedFormatsWithEotOnlyTarget), content, locale, session);
}

describe("NotAFileMiddleware", function () {
    it("asks for a file in reply to a text", async function () {
        const { replies, isPassedOn } = await run({ text: "hello" });

        expect(replies).to.deep.equal(["Пришлите шрифт файлом — TTF, OTF, WOFF, WOFF2, SVG."]);
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

        expect(replies).to.deep.equal(["Send the font as a file: TTF, OTF, WOFF, WOFF2, SVG."]);
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

    // Telegram sends an album as one message per photo, each an update of its own.
    it("asks once for an album, then again for the next one", async function () {
        const session = initialPayload();
        const answered: number[] = [];

        for (const mediaGroupId of ["first", "first", "first", "second", "second"]) {
            const { replies } = await run({ photo: [], media_group_id: mediaGroupId }, DEFAULT_LOCALE, session);
            answered.push(replies.length);
        }

        expect(answered).to.deep.equal([1, 0, 0, 1, 0]);
    });

    it("asks for every photo sent on its own", async function () {
        const session = initialPayload();

        const first = await run({ photo: [] }, DEFAULT_LOCALE, session);
        const second = await run({ photo: [] }, DEFAULT_LOCALE, session);

        expect([first.replies.length, second.replies.length]).to.deep.equal([1, 1]);
    });

    it("asks for a giveaway winners post forwarded to the bot", async function () {
        const { replies } = await run({ giveaway_winners: {} as GiveawayWinners });

        expect(replies).to.have.lengthOf(1);
    });
});
