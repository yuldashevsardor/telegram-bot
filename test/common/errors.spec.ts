import { expect } from "chai";
import { RuntimeError } from "app/common/errors";

class ChildError extends RuntimeError {}

describe("RuntimeError.byError", function () {
    it("returns the error instead of throwing it", function () {
        const error = RuntimeError.byError(new Error("boom"));

        expect(error).to.be.instanceOf(RuntimeError);
        expect(error.message).to.equal("boom");
        expect(error.payload).to.deep.equal({ error: new Error("boom") });
    });

    it("returns an instance of the subclass it was called on", function () {
        const error = ChildError.byError(new Error("boom"));

        expect(error).to.be.instanceOf(ChildError);
    });

    it("returns an instance of the subclass for a value that is not an Error", function () {
        const error = ChildError.byError("boom");

        expect(error).to.be.instanceOf(ChildError);
        expect(error.payload).to.deep.equal({ error: "boom" });
    });
});
