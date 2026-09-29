import { expect } from "chai";
import { computeRetryDelayMs } from "app/telegram/outbox/retry-delay";
import type { RetryDelaySettings } from "app/telegram/outbox/retry-delay";

const SETTINGS: RetryDelaySettings = { firstDelayMs: 1000, maxDelayMs: 30_000 };

// Math.random never returns 1: this is the largest number it can. Half a step plus nearly half a
// step rounds to the whole step in floating point, so the whole step is the upper bound.
const LARGEST_RANDOM = 1 - Number.EPSILON / 2;

describe("Outbox retry delay", function () {
    it("takes the first step after the first counted attempt", function () {
        expect(computeRetryDelayMs(1, SETTINGS, () => 0.5)).to.equal(750);
    });

    it("doubles the step with every further counted attempt", function () {
        const delaysMs = [2, 3, 4, 5].map((countedAttempts) => computeRetryDelayMs(countedAttempts, SETTINGS, () => 0.5));

        expect(delaysMs).to.deep.equal([1500, 3000, 6000, 12_000]);
    });

    it("stops the growth at the maximum step", function () {
        expect(computeRetryDelayMs(6, SETTINGS, () => 0.5)).to.equal(22_500);
        expect(computeRetryDelayMs(1000, SETTINGS, () => 0.5)).to.equal(22_500);
    });

    it("keeps the delay of every step between its half and its whole", function () {
        for (let countedAttempts = 1; countedAttempts <= 8; countedAttempts++) {
            const stepMs = Math.min(SETTINGS.firstDelayMs * 2 ** (countedAttempts - 1), SETTINGS.maxDelayMs);

            expect(computeRetryDelayMs(countedAttempts, SETTINGS, () => 0)).to.equal(stepMs / 2);

            const largestDelayMs = computeRetryDelayMs(countedAttempts, SETTINGS, () => LARGEST_RANDOM);
            expect(largestDelayMs).to.be.above(stepMs * 0.99);
            expect(largestDelayMs).to.be.at.most(stepMs);
        }
    });

    it("draws the jitter from Math.random when no random source is passed", function () {
        const delayMs = computeRetryDelayMs(1, SETTINGS);

        expect(delayMs).to.be.at.least(500);
        expect(delayMs).to.be.below(1000);
    });
});
