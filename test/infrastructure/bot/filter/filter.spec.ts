import "reflect-metadata";
import { expect } from "chai";
import { Composer } from "grammy";
import { Context } from "app/infrastructure/bot/bot.types";
import { Filter } from "app/infrastructure/bot/filter/filter";

class StubFilter extends Filter {
    public constructor(private readonly result: boolean) {
        super();
    }

    protected handle(): boolean {
        return this.result;
    }
}

// Повторяет схему Bot.setup(): фильтр и то, что за ним, живут в разных composer'ах,
// оба подключены к корневому. Именно так пропадал отброс, когда setup() полагался
// на composer.filter().
async function isPassedDown(result: boolean): Promise<boolean> {
    const root = new Composer<Context>();

    const filterComposer = new Composer<Context>();
    new StubFilter(result).setup(filterComposer);
    root.use(filterComposer);

    let passed = false;
    const nextComposer = new Composer<Context>();
    nextComposer.use(async (_ctx, next) => {
        passed = true;

        return next();
    });
    root.use(nextComposer);

    await root.middleware()({} as Context, () => Promise.resolve());

    return passed;
}

describe("Filter", function () {
    it("stops the chain when the predicate is false", async function () {
        expect(await isPassedDown(false)).to.equal(false);
    });

    it("passes the update down when the predicate is true", async function () {
        expect(await isPassedDown(true)).to.equal(true);
    });
});
