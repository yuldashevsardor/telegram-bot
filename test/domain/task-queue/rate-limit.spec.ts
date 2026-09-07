import { expect } from "chai";
import { RateLimit } from "app/domain/task-queue/rate-limit";
import { RateLimitIsBusy } from "app/domain/task-queue/rate-limit.errors";

const limitNumber = 10;
const limitInterval = 1000;
const reserveDuration = limitInterval / limitNumber;

describe("RateLimit", function () {
    this.timeout(limitInterval * 3);

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
        expect(() => rateLimit.reserve()).to.throw(RateLimitIsBusy, "Can't reserve until the rate limit is free.");
    });
});

function build(): RateLimit {
    return new RateLimit({
        interval: limitInterval,
        number: limitNumber,
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
