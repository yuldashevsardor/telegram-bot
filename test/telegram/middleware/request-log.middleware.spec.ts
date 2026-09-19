import "reflect-metadata";
import { expect } from "chai";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { RequestLogMiddleware } from "app/telegram/middleware/request-log.middleware";

type DebugRecord = { message: string; payload: UnknownObject | undefined };

function buildLogger(records: DebugRecord[]): Logger {
    return {
        critical: () => undefined,
        error: () => undefined,
        warning: () => undefined,
        info: () => undefined,
        debug: (message: string, payload?: UnknownObject): void => {
            records.push({ message: message, payload: payload });
        },
    };
}

async function run(ctx: Context, records: DebugRecord[] = []): Promise<boolean> {
    let passed = false;
    const composer = new Composer<Context>();
    new RequestLogMiddleware(buildLogger(records)).setup(composer);
    composer.use(async () => {
        passed = true;
    });

    await composer.middleware()(ctx, () => Promise.resolve());

    return passed;
}

function buildContext(requestCount: number): Context {
    return { update: { update_id: 42 }, session: { requestCount: requestCount } } as Context;
}

describe("RequestLogMiddleware", function () {
    it("counts the update in the session", async function () {
        const ctx = buildContext(7);

        await run(ctx);

        expect(ctx.session.requestCount).to.equal(8);
    });

    it("dumps the whole update on debug", async function () {
        const ctx = buildContext(0);
        const records: DebugRecord[] = [];

        await run(ctx, records);

        expect(records).to.deep.equal([{ message: "Request", payload: { update: ctx.update } }]);
    });

    it("passes the update down", async function () {
        expect(await run(buildContext(0))).to.equal(true);
    });
});
