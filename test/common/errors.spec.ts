import { expect } from "chai";
import { RuntimeError } from "app/common/errors";

class ChildError extends RuntimeError {}

describe("RuntimeError", function () {
    it("keeps the second argument as payload", function () {
        const error = new RuntimeError("boom", { userId: 42 });

        expect(error.message).to.equal("boom");
        expect(error.payload).to.deep.equal({ userId: 42 });
        expect(error.cause).to.be.undefined;
    });

    it("puts an Error second argument into cause and leaves payload empty", function () {
        const cause = new Error("original");
        const error = new RuntimeError("boom", cause);

        expect(error.cause).to.equal(cause);
        expect(error.payload).to.be.undefined;
    });

    it("lifts cause out of the payload", function () {
        const cause = new Error("original");
        const error = new RuntimeError("boom", { userId: 42, cause: cause });

        expect(error.cause).to.equal(cause);
        expect(error.payload).to.deep.equal({ userId: 42 });
    });

    it("leaves payload empty when the object had nothing but cause", function () {
        const error = new RuntimeError("boom", { cause: new Error("original") });

        expect(error.payload).to.be.undefined;
    });

    it("ignores a cause in the payload that is not an Error", function () {
        const error = new RuntimeError("boom", { cause: "original" });

        expect(error.cause).to.be.undefined;
        expect(error.payload).to.deep.equal({ cause: "original" });
    });
});

describe("RuntimeError.byError", function () {
    it("returns the error instead of throwing it", function () {
        const cause = new Error("boom");
        const error = RuntimeError.byError(cause);

        expect(error).to.be.instanceOf(RuntimeError);
        expect(error.message).to.equal("boom");
        expect(error.cause).to.equal(cause);
        expect(error.payload).to.be.undefined;
    });

    it("returns an instance of the subclass it was called on", function () {
        const error = ChildError.byError(new Error("boom"));

        expect(error).to.be.instanceOf(ChildError);
    });

    it("returns an instance of the subclass for a value that is not an Error", function () {
        const error = ChildError.byError("boom");

        expect(error).to.be.instanceOf(ChildError);
        expect(error.cause).to.be.undefined;
        expect(error.payload).to.deep.equal({ error: "boom" });
    });
});
