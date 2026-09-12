import "reflect-metadata";
import { expect } from "chai";
import { Context, Conversation } from "app/infrastructure/bot/bot.types";
import { ConversationHandler } from "app/infrastructure/bot/conversation/conversation-handler";

type Entered = {
    conversation: Conversation;
    ctx: Context;
};

class StubConversationHandler extends ConversationHandler {
    public readonly name: string = "stub";
    public readonly seenAfterAwait: Entered[] = [];

    protected async run(conversation: Conversation, ctx: Context): Promise<void> {
        // Уступка исполнения в той же точке, где реальный разговор ждёт сети или
        // следующего апдейта: в это окно плагин успевает завести разговор другого
        // пользователя тем же экземпляром обработчика.
        await Promise.resolve();

        this.seenAfterAwait.push({ conversation: conversation, ctx: ctx });
    }
}

describe("ConversationHandler", function () {
    it("keeps ctx and conversation of concurrent conversations apart", async function () {
        const handler = new StubConversationHandler();
        const first: Entered = { conversation: {} as Conversation, ctx: {} as Context };
        const second: Entered = { conversation: {} as Conversation, ctx: {} as Context };

        await Promise.all([handler.handle(first.conversation, first.ctx), handler.handle(second.conversation, second.ctx)]);

        expect(handler.seenAfterAwait).to.have.lengthOf(2);
        expect(handler.seenAfterAwait[0]?.conversation).to.equal(first.conversation);
        expect(handler.seenAfterAwait[0]?.ctx).to.equal(first.ctx);
        expect(handler.seenAfterAwait[1]?.conversation).to.equal(second.conversation);
        expect(handler.seenAfterAwait[1]?.ctx).to.equal(second.ctx);
    });
});
