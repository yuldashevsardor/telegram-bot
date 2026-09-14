import "reflect-metadata";
import { expect } from "chai";
import { Composer } from "grammy";
import type { Context } from "app/telegram/bot.types";
import type { Logger } from "app/platform/logger/logger";
import { ResponseTimeMiddleware } from "app/telegram/middleware/response-time.middleware";

function buildLogger(messages: string[]): Logger {
    return {
        critical: () => undefined,
        error: () => undefined,
        warning: () => undefined,
        info: (message: string): void => {
            messages.push(message);
        },
        debug: () => undefined,
    };
}

async function run(messages: string[], next: () => Promise<void>): Promise<void> {
    const composer = new Composer<Context>();
    new ResponseTimeMiddleware(buildLogger(messages)).setup(composer);
    composer.use(next);

    await composer.middleware()({} as Context, () => Promise.resolve());
}

describe("ResponseTimeMiddleware", function () {
    it("logs the time after the rest of the chain is done", async function () {
        const messages: string[] = [];
        let loggedBeforeDone = true;

        const start = Date.now();
        await run(messages, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            loggedBeforeDone = messages.length > 0;
        });
        const elapsed = Date.now() - start;

        expect(loggedBeforeDone).to.equal(false);
        expect(messages).to.have.lengthOf(1);

        const [, time] = /^Response time: (\d+) ms$/.exec(messages[0] ?? "") ?? [];

        expect(Number(time)).to.be.within(0, elapsed);
    });

    // Без try/catch вокруг next(): у упавшего апдейта строки времени нет, ошибка уходит
    // дальше, в Bot.handleError.
    it("logs nothing and passes the error up when the chain fails", async function () {
        const messages: string[] = [];
        const error = new Error("chain failed");

        let caught: unknown = undefined;
        await run(messages, () => Promise.reject(error)).catch((reason: unknown) => {
            caught = reason;
        });

        expect(caught).to.equal(error);
        expect(messages).to.have.lengthOf(0);
    });
});
