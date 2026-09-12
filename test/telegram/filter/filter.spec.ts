import "reflect-metadata";
import { expect } from "chai";
import { Composer } from "grammy";
import { Context } from "app/telegram/bot.types";
import { Filter } from "app/telegram/filter/filter";
import { Logger } from "app/platform/logger/logger";
import { UnknownObject } from "app/shared/types";

type DebugRecord = { message: string; payload: UnknownObject | undefined };

class StubFilter extends Filter {
    public constructor(logger: Logger, private readonly result: boolean) {
        super(logger);
    }

    protected handle(): boolean {
        return this.result;
    }
}

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

// Повторяет схему Bot.setup(): фильтр и то, что за ним, живут в разных composer'ах,
// оба подключены к корневому. Именно так пропадал отброс, когда setup() полагался
// на composer.filter().
async function run(result: boolean): Promise<{ passed: boolean; records: DebugRecord[] }> {
    const records: DebugRecord[] = [];
    const root = new Composer<Context>();

    const filterComposer = new Composer<Context>();
    new StubFilter(buildLogger(records), result).setup(filterComposer);
    root.use(filterComposer);

    let passed = false;
    const nextComposer = new Composer<Context>();
    nextComposer.use(async (_ctx, next) => {
        passed = true;

        return next();
    });
    root.use(nextComposer);

    await root.middleware()({ update: { update_id: 42 } } as Context, () => Promise.resolve());

    return { passed: passed, records: records };
}

describe("Filter", function () {
    it("stops the chain when the predicate is false", async function () {
        expect((await run(false)).passed).to.equal(false);
    });

    it("passes the update down when the predicate is true", async function () {
        expect((await run(true)).passed).to.equal(true);
    });

    it("logs the dropped update with the filter name", async function () {
        const { records } = await run(false);

        expect(records).to.have.lengthOf(1);
        expect(records[0]?.payload).to.deep.equal({ filter: "StubFilter", updateId: 42 });
    });

    it("does not log the update passed down", async function () {
        expect((await run(true)).records).to.have.lengthOf(0);
    });
});
