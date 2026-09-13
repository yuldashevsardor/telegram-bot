import { expect } from "chai";
import { NumberHelper } from "app/shared/number-helper";

describe("NumberHelper.generateNumber", function () {
    const random = Math.random;

    afterEach(function () {
        Math.random = random;
    });

    it("reaches the lower bound", function () {
        Math.random = (): number => 0;

        expect(NumberHelper.generateNumber(3, 7)).to.equal(3);
    });

    it("reaches the upper bound", function () {
        Math.random = (): number => 0.999;

        expect(NumberHelper.generateNumber(3, 7)).to.equal(7);
    });
});
