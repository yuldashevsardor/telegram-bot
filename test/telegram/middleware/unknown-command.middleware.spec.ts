import "reflect-metadata";
import { expect } from "chai";
import type { Message, Sticker } from "@grammyjs/types";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { HelpCommand } from "app/telegram/command/help/help.command";
import { UnknownCommandMiddleware } from "app/telegram/middleware/unknown-command.middleware";
import { command, replyContext } from "test/telegram/reply-context.helper";

async function run(content: Partial<Message>): Promise<{ helped: Context[]; passed: boolean }> {
    const helped: Context[] = [];
    const helpCommand = {
        handle: async (ctx: Context): Promise<void> => {
            helped.push(ctx);
        },
    } as HelpCommand;
    const { ctx } = await replyContext(content);
    const composer = new Composer<Context>();
    new UnknownCommandMiddleware(helpCommand).setup(composer);
    let passed = false;

    await composer.middleware()(ctx, async () => {
        passed = true;
    });

    return { helped: helped, passed: passed };
}

describe("UnknownCommandMiddleware", function () {
    it("answers a command with the help", async function () {
        const { helped, passed } = await run(command("/unknown"));

        expect(helped).to.have.lengthOf(1);
        expect(passed).to.equal(false);
    });

    it("passes on a text without a command", async function () {
        const { helped, passed } = await run({ text: "hello" });

        expect(helped).to.deep.equal([]);
        expect(passed).to.equal(true);
    });

    // grammY's command() takes a command only at the start of the text, and so does the help.
    it("passes on a text with a command past its start", async function () {
        const { helped, passed } = await run({ text: "see /start", entities: [{ type: "bot_command", offset: 4, length: 6 }] });

        expect(helped).to.deep.equal([]);
        expect(passed).to.equal(true);
    });

    it("passes on a message without a text", async function () {
        const { helped, passed } = await run({ sticker: {} as Sticker });

        expect(helped).to.deep.equal([]);
        expect(passed).to.equal(true);
    });
});
