import { expect } from "chai";
import { NumberHelper } from "app/shared/number-helper";

describe("NumberHelper.roundUp", function () {
    it("rounds a value up to the next multiple", function () {
        expect(NumberHelper.roundUp(5, 4)).to.equal(8);
        expect(NumberHelper.roundUp(7, 4)).to.equal(8);
    });

    it("keeps a value that is a multiple already, 0 included", function () {
        expect(NumberHelper.roundUp(8, 4)).to.equal(8);
        expect(NumberHelper.roundUp(0, 4)).to.equal(0);
    });

    it("rounds a value past 2^31 without a sign flip", function () {
        expect(NumberHelper.roundUp(0xfffffffd, 4)).to.equal(0x100000000);
    });
});

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
