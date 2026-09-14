import "reflect-metadata";
import { expect } from "chai";
import type { Chat } from "@grammyjs/types";
import type { Context } from "app/telegram/bot.types";
import { IsPrivateChatFilter } from "app/telegram/filter/is-private-chat.filter";
import type { Logger } from "app/platform/logger/logger";

class ExposedIsPrivateChatFilter extends IsPrivateChatFilter {
    public check(ctx: Context): boolean {
        return this.handle(ctx);
    }
}

const logger: Logger = {
    critical: () => undefined,
    error: () => undefined,
    warning: () => undefined,
    info: () => undefined,
    debug: () => undefined,
};

function check(chat: Pick<Chat, "type"> | undefined): boolean {
    return new ExposedIsPrivateChatFilter(logger).check({ chat: chat } as Context);
}

describe("IsPrivateChatFilter", function () {
    it("passes a private chat", function () {
        expect(check({ type: "private" })).to.equal(true);
    });

    for (const type of ["group", "supergroup", "channel"] as const) {
        it(`drops a ${type}`, function () {
            expect(check({ type: type })).to.equal(false);
        });
    }

    it("drops an update without chat", function () {
        expect(check(undefined)).to.equal(false);
    });
});
