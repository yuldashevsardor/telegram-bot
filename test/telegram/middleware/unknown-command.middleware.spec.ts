import "reflect-metadata";
import { expect } from "chai";
import type { Message, Sticker } from "@grammyjs/types";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { HelpCommand } from "app/telegram/command/help/help.command";
import { UnknownCommandMiddleware } from "app/telegram/middleware/unknown-command.middleware";
import { command, replyContext } from "test/telegram/reply-context.helper";

async function run(content: Partial<Message>): Promise<{ helped: Context[]; isPassedOn: boolean }> {
    const helped: Context[] = [];
    const helpCommand = {
        handle: async (ctx: Context): Promise<void> => {
            helped.push(ctx);
        },
    } as HelpCommand;
    const { ctx } = await replyContext(content);
    const composer = new Composer<Context>();
    new UnknownCommandMiddleware(helpCommand).setup(composer);
    let isPassedOn = false;

    await composer.middleware()(ctx, async () => {
        isPassedOn = true;
    });

    return { helped: helped, isPassedOn: isPassedOn };
}

describe("UnknownCommandMiddleware", function () {
    it("answers a command with the help", async function () {
        const { helped, isPassedOn } = await run(command("/unknown"));

        expect(helped).to.have.lengthOf(1);
        expect(isPassedOn).to.equal(false);
    });

    it("passes on a text without a command", async function () {
        const { helped, isPassedOn } = await run({ text: "hello" });

        expect(helped).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    // grammY's command() takes a command only at the start of the text, and so does the help.
    it("passes on a text with a command past its start", async function () {
        const { helped, isPassedOn } = await run({ text: "see /start", entities: [{ type: "bot_command", offset: 4, length: 6 }] });

        expect(helped).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });

    it("passes on a message without a text", async function () {
        const { helped, isPassedOn } = await run({ sticker: {} as Sticker });

        expect(helped).to.deep.equal([]);
        expect(isPassedOn).to.equal(true);
    });
});
