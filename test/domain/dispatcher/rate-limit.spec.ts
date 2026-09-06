import { expect } from "chai";
import { RateLimit } from "app/domain/dispatcher/rate-limit";

const rateNumber = 10;
const rateInterval = 1000;
const reserveDuration = rateInterval / rateNumber;

describe("RateLimit", function () {
    this.timeout(rateInterval * 3);

    it("limit is free", function () {
        const rateLimit = build();

        expect(rateLimit.isFree()).to.be.true;
    });

    it("limit is not free after reserve", function () {
        const rateLimit = build();

        rateLimit.reserve();

        expect(rateLimit.isFree()).to.be.false;
    });

    it("limit is free after reserve duration", async function () {
        const rateLimit = build();

        rateLimit.reserve();
        await delay(reserveDuration + 10);

        expect(rateLimit.isFree()).to.be.true;
    });

    it("catch an error when calling a reserve while the limit is not free", function () {
        const rateLimit = build();

        rateLimit.reserve();
        expect(() => rateLimit.reserve()).to.throw(Error, "Can't reserve until the rate limit is free");
    });
});

function build(): RateLimit {
    return new RateLimit({
        interval: rateInterval,
        number: rateNumber,
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
