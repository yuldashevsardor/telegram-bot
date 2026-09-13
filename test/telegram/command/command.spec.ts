import "reflect-metadata";
import { expect } from "chai";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot.types";
import { Command } from "app/telegram/command/command";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

class StubCommand extends Command {
    public readonly command: string = "stub";
    public readonly descriptionKey: string = "stub-command-description";
    public readonly handled: Context[] = [];

    protected async handle(ctx: Context): Promise<void> {
        this.handled.push(ctx);
    }
}

function commandUpdate(text: string): Update {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, is_bot: false, first_name: "User" },
            text: text,
            entities: [{ type: "bot_command", offset: 0, length: text.length }],
        },
    };
}

async function run(text: string): Promise<{ command: StubCommand; ctx: Context; passed: boolean }> {
    const command = new StubCommand();
    const composer = new Composer<Context>();
    command.setup(composer);

    const ctx = new GrammyContext(commandUpdate(text), new Api("test-token"), ME) as Context;
    let passed = false;
    await composer.middleware()(ctx, async () => {
        passed = true;
    });

    return { command: command, ctx: ctx, passed: passed };
}

describe("Command", function () {
    it("handles its own command", async function () {
        const { command, ctx } = await run("/stub");

        expect(command.handled).to.have.lengthOf(1);
        expect(command.handled[0]).to.equal(ctx);
    });

    it("handles its own command addressed to the bot", async function () {
        const { command } = await run("/stub@test_bot");

        expect(command.handled).to.have.lengthOf(1);
    });

    it("passes another command down", async function () {
        const { command, passed } = await run("/other");

        expect(command.handled).to.have.lengthOf(0);
        expect(passed).to.equal(true);
    });
});
