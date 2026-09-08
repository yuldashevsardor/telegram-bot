import "reflect-metadata";
import { expect } from "chai";
import { AsyncLocalStorage } from "async_hooks";
import { RequestContext } from "app/infrastructure/request-context";
import { REQUEST_KEYS, RequestStore } from "app/infrastructure/request-context.types";

describe("RequestContext", function () {
    it("gives the running function a request id", function () {
        const context = new RequestContext();

        const requestId = context.run(() => context.getRequestId());

        expect(requestId).to.be.a("string").and.not.empty;
    });

    it("gives every scope its own request id", function () {
        const context = new RequestContext();

        const first = context.run(() => context.getRequestId());
        const second = context.run(() => context.getRequestId());

        expect(first).to.not.equal(second);
    });

    it("keeps the request id inside the scope across awaits", async function () {
        const context = new RequestContext();

        const [inside, after] = await context.run(async () => {
            const before = context.getRequestId();
            await Promise.resolve();

            return [before, context.getRequestId()];
        });

        expect(inside).to.be.a("string");
        expect(after).to.equal(inside);
    });

    it("puts the request id into the values", function () {
        const context = new RequestContext();

        const values = context.run(() => context.getValues());

        expect(Object.keys(values)).to.deep.equal([REQUEST_KEYS.REQUEST_ID]);
    });

    it("has no request data outside a scope", function () {
        const context = new RequestContext();

        expect(context.getRequestId()).to.be.null;
        expect(context.getValues()).to.deep.equal({});
    });

    it("keeps unknown keys of the store out of the values", function () {
        const context = new RequestContext();
        // Область открывает только run(), и чужой ключ через публичную поверхность в стор
        // не попадёт — отбор в getValues() сторожит будущих писателей стора, поэтому здесь
        // ключ кладётся прямо в хранилище.
        const als = (context as unknown as { als: AsyncLocalStorage<RequestStore> }).als;

        const values = als.run({ [REQUEST_KEYS.REQUEST_ID]: "req-1", secret: "must not leak" } as RequestStore, () => context.getValues());

        expect(values).to.deep.equal({ requestId: "req-1" });
    });
});
