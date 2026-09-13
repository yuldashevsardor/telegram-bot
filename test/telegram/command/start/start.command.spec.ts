import "reflect-metadata";
import { expect } from "chai";
import type { Context } from "app/telegram/bot.types";
import type { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { StartCommand } from "app/telegram/command/start/start.command";

class ExposedStartCommand extends StartCommand {
    public run(ctx: Context): Promise<void> {
        return this.handle(ctx);
    }
}

describe("StartCommand", function () {
    it("enters the start conversation with the update context", async function () {
        const entered: Context[] = [];
        const startConversation = {
            enter: async (ctx: Context): Promise<void> => {
                entered.push(ctx);
            },
        } as unknown as StartConversation;
        const ctx = {} as Context;

        await new ExposedStartCommand(startConversation).run(ctx);

        expect(entered).to.have.lengthOf(1);
        expect(entered[0]).to.equal(ctx);
    });
});
