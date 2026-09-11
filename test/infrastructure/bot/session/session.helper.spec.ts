import { expect } from "chai";
import { Context } from "app/infrastructure/bot/bot.types";
import { getSessionKey, initialPayload } from "app/infrastructure/bot/session/session.helper";

type ContextWithoutSession = Omit<Context, "session">;

function buildContext(from: { id: number } | undefined, chat: { id: number } | undefined): ContextWithoutSession {
    return { from: from, chat: chat } as ContextWithoutSession;
}

describe("getSessionKey", function () {
    it("builds the key from from.id and chat.id", function () {
        expect(getSessionKey(buildContext({ id: 42 }, { id: 99 }))).to.equal("42:99");
    });

    it("returns undefined without from", function () {
        expect(getSessionKey(buildContext(undefined, { id: 99 }))).to.be.undefined;
    });

    it("returns undefined without chat", function () {
        expect(getSessionKey(buildContext({ id: 42 }, undefined))).to.be.undefined;
    });
});

describe("initialPayload", function () {
    it("starts the counter at zero", function () {
        expect(initialPayload()).to.deep.equal({ requestCount: 0 });
    });

    // session() зовёт initial на каждую новую сессию: общий объект раздал бы
    // requestCount одного пользователя всем остальным.
    it("returns a fresh object on every call", function () {
        const payload = initialPayload();
        payload.requestCount = 7;

        expect(initialPayload().requestCount).to.equal(0);
    });
});
