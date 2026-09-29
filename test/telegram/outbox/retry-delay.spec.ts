import { expect } from "chai";
import { RetryDelay } from "app/telegram/outbox/retry-delay";
import type { RetryDelaySettings } from "app/telegram/outbox/retry-delay";

const SETTINGS: RetryDelaySettings = { firstDelayMs: 1000, maxDelayMs: 30_000, multiplier: 2 };

// Math.random never returns 1: this is the largest number it can. Half a step plus nearly half a
// step rounds to the whole step in floating point, so the whole step is the upper bound.
const LARGEST_RANDOM = 1 - Number.EPSILON / 2;

// How far below the whole step the largest delay may land: the jitter covers the upper half of the
// step, so the largest random brings the delay to the step itself, give or take the rounding.
const ROUNDING_TOLERANCE_MS = 0.001;

// The steps of SETTINGS by counted attempt, from the first: doubled until the cap stops them.
const STEPS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];

describe("Outbox retry delay", function () {
    it("takes the first step after the first counted attempt", function () {
        expect(new RetryDelay(SETTINGS, () => 0.5).computeMs(1)).to.equal(750);
    });

    it("doubles the step with every further counted attempt", function () {
        const retryDelay = new RetryDelay(SETTINGS, () => 0.5);
        const delaysMs = [2, 3, 4, 5].map((countedAttempts) => retryDelay.computeMs(countedAttempts));

        expect(delaysMs).to.deep.equal([1500, 3000, 6000, 12_000]);
    });

    it("stops the growth at the cap", function () {
        const retryDelay = new RetryDelay(SETTINGS, () => 0.5);

        expect(retryDelay.computeMs(6)).to.equal(22_500);
        expect(retryDelay.computeMs(1000)).to.equal(22_500);
    });

    it("keeps the delay of every step between its half and its whole", function () {
        STEPS_MS.forEach((stepMs, stepIndex) => {
            const countedAttempts = stepIndex + 1;

            expect(new RetryDelay(SETTINGS, () => 0).computeMs(countedAttempts)).to.equal(stepMs / 2);

            const largestDelayMs = new RetryDelay(SETTINGS, () => LARGEST_RANDOM).computeMs(countedAttempts);
            expect(largestDelayMs).to.be.closeTo(stepMs, ROUNDING_TOLERANCE_MS);
            expect(largestDelayMs).to.be.at.most(stepMs);
        });
    });

    it("multiplies the step by the multiplier of the settings", function () {
        const retryDelay = new RetryDelay({ ...SETTINGS, multiplier: 3 }, () => 0.5);

        expect([1, 2, 3].map((countedAttempts) => retryDelay.computeMs(countedAttempts))).to.deep.equal([750, 2250, 6750]);
    });

    it("keeps the step constant under a multiplier of 1", function () {
        const retryDelay = new RetryDelay({ ...SETTINGS, multiplier: 1 }, () => 0.5);

        expect([1, 2, 10].map((countedAttempts) => retryDelay.computeMs(countedAttempts))).to.deep.equal([750, 750, 750]);
    });

    it("draws the jitter from Math.random when no random source is passed", function () {
        const delayMs = new RetryDelay(SETTINGS).computeMs(1);

        expect(delayMs).to.be.at.least(500);
        expect(delayMs).to.be.below(1000);
    });
});
