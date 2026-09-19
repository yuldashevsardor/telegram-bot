import "reflect-metadata";
import { expect } from "chai";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import { RequestContext } from "app/platform/request-context/request-context";
import { RequestContextMiddleware } from "app/telegram/middleware/request-context.middleware";

async function run(requestContext: RequestContext, next: () => Promise<void>): Promise<void> {
    const composer = new Composer<Context>();
    new RequestContextMiddleware(requestContext).setup(composer);
    composer.use(next);

    await composer.middleware()({} as Context, () => Promise.resolve());
}

describe("RequestContextMiddleware", function () {
    it("runs the rest of the chain with a request id", async function () {
        const requestContext = new RequestContext();
        let requestId: string | null = null;

        await run(requestContext, async () => {
            await Promise.resolve();
            requestId = requestContext.getRequestId();
        });

        expect(requestId).to.be.a("string").and.not.empty;
    });

    it("gives every update its own request id", async function () {
        const requestContext = new RequestContext();
        const requestIds: Array<string | null> = [];
        const next = async (): Promise<void> => {
            requestIds.push(requestContext.getRequestId());
        };

        await run(requestContext, next);
        await run(requestContext, next);

        expect(requestIds).to.have.lengthOf(2);
        expect(requestIds[0]).to.not.equal(requestIds[1]);
    });
});
