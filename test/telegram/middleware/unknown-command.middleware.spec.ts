import "reflect-metadata";
import { expect } from "chai";
import type { Message, Sticker } from "@grammyjs/types";
import { UnknownCommandMiddleware } from "app/telegram/middleware/unknown-command.middleware";
import type { HandlerRun } from "test/telegram/handler.helper";
import { commandMessage, helpText, runHandler } from "test/telegram/handler.helper";

function run(content: Partial<Message>): Promise<HandlerRun> {
    return runHandler(new UnknownCommandMiddleware(helpText), content);
}

describe("UnknownCommandMiddleware", function () {
    it("answers a command with the help", async function () {
        const { ctx, replies, isPassedOn } = await run(commandMessage("/unknown"));

        expect(replies).to.deep.equal([helpText.build(ctx)]);
        expect(isPassedOn).to.equal(false);
    });

    it("passes on a text without a command", async function () {
        const { replies, isPassedOn } = await run({ text: "hello" });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    // grammY's command() takes a command only at the start of the text, and so does the help.
    it("passes on a text with a command past its start", async function () {
        const { replies, isPassedOn } = await run({ text: "see /start", entities: [{ type: "bot_command", offset: 4, length: 6 }] });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    it("passes on a message without a text", async function () {
        const { replies, isPassedOn } = await run({ sticker: {} as Sticker });

        expect(replies).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });
});
