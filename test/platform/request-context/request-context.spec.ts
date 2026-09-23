import "reflect-metadata";
import { expect } from "chai";
import type { AsyncLocalStorage } from "async_hooks";
import { RequestContext } from "app/platform/request-context/request-context";
import type { RequestStore } from "app/platform/request-context/request-context.types";
import { REQUEST_KEYS } from "app/platform/request-context/request-context.types";

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

    it("leaves no request data after a scope ends", async function () {
        const context = new RequestContext();

        await context.run(() => Promise.resolve());

        expect(context.getRequestId()).to.be.null;
        expect(context.getValues()).to.deep.equal({});
    });

    it("keeps unknown keys of the store out of the values", function () {
        const context = new RequestContext();
        // Only run() opens a scope, and a foreign key cannot reach the store through the public
        // surface — the filter in getValues() guards against future writers of the store, so here
        // the key is put straight into the storage.
        const als = (context as unknown as { als: AsyncLocalStorage<RequestStore> }).als;

        const values = als.run({ [REQUEST_KEYS.REQUEST_ID]: "req-1", secret: "must not leak" } as RequestStore, () => context.getValues());

        expect(values).to.deep.equal({ requestId: "req-1" });
    });

    // run() never opens a store without a requestId, so, as above, it is put straight into the storage.
    // A key with the value undefined would be printed by ConsoleLogger as [requestId=undefined].
    it("keeps keys missing from the store out of the values", function () {
        const context = new RequestContext();
        const als = (context as unknown as { als: AsyncLocalStorage<RequestStore> }).als;

        const values = als.run({}, () => context.getValues());

        expect(values).to.not.have.property(REQUEST_KEYS.REQUEST_ID);
    });
});
