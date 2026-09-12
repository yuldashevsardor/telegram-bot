import "reflect-metadata";
import { expect } from "chai";
import { Context } from "app/telegram/bot.types";
import { HasSessionKeyFilter } from "app/telegram/filter/has-session-key.filter";
import { getSessionKey } from "app/telegram/session/session.helper";
import { Logger } from "app/platform/logger/logger";
import { UnknownObject } from "app/shared/types";

type WarningRecord = { message: string; payload: UnknownObject | undefined };

type Case = { name: string; ctx: Context; passes: boolean; payload?: UnknownObject };

class ExposedHasSessionKeyFilter extends HasSessionKeyFilter {
    public check(ctx: Context): boolean {
        return this.handle(ctx);
    }
}

function buildLogger(records: WarningRecord[]): Logger {
    return {
        critical: () => undefined,
        error: () => undefined,
        warning: (message: string, payload?: UnknownObject): void => {
            records.push({ message: message, payload: payload });
        },
        info: () => undefined,
        debug: () => undefined,
    };
}

function buildContext(from: { id: number } | undefined, chat: { id: number } | undefined): Context {
    return { update: { update_id: 42 }, from: from, chat: chat } as Context;
}

function run(ctx: Context): { passed: boolean; records: WarningRecord[] } {
    const records: WarningRecord[] = [];
    const passed = new ExposedHasSessionKeyFilter(buildLogger(records)).check(ctx);

    return { passed: passed, records: records };
}

const cases: Case[] = [
    { name: "with from and chat", ctx: buildContext({ id: 1 }, { id: 2 }), passes: true },
    {
        name: "without from",
        ctx: buildContext(undefined, { id: 2 }),
        passes: false,
        payload: { updateId: 42, hasFrom: false, hasChat: true },
    },
    {
        name: "without chat",
        ctx: buildContext({ id: 1 }, undefined),
        passes: false,
        payload: { updateId: 42, hasFrom: true, hasChat: false },
    },
    // Нулевой id ложен, но ключ из него строится: проверка «на истинность» вместо
    // «на undefined» разошлась бы с getSessionKey именно здесь.
    { name: "with zero ids", ctx: buildContext({ id: 0 }, { id: 0 }), passes: true },
];

describe("HasSessionKeyFilter", function () {
    for (const { name, ctx, passes, payload } of cases) {
        describe(name, function () {
            it(passes ? "passes the update" : "drops the update", function () {
                expect(run(ctx).passed).to.equal(passes);
            });

            it(payload === undefined ? "logs nothing" : "logs a warning with what is missing", function () {
                const { records } = run(ctx);

                if (payload === undefined) {
                    expect(records).to.have.lengthOf(0);

                    return;
                }

                expect(records).to.have.lengthOf(1);
                expect(records[0]?.payload).to.deep.equal(payload);
            });

            // Фильтр стоит выше session() ради того, чтобы до неё не дошёл апдейт без
            // ключа: отброшенное им обязано совпадать с тем, чему session() ключа не даст.
            it("agrees with getSessionKey used by session()", function () {
                expect(run(ctx).passed).to.equal(getSessionKey(ctx) !== undefined);
            });
        });
    }
});
