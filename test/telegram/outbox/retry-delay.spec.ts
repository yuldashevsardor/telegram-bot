import { expect } from "chai";
import { computeRetryDelayMs } from "app/telegram/outbox/retry-delay";
import type { RetryDelaySettings } from "app/telegram/outbox/retry-delay";

const SETTINGS: RetryDelaySettings = { firstDelayMs: 1000, maxDelayMs: 30_000 };

// Math.random never returns 1: this is the largest number it can. Half a step plus nearly half a
// step rounds to the whole step in floating point, so the whole step is the upper bound.
const LARGEST_RANDOM = 1 - Number.EPSILON / 2;

// How far below the whole step the largest delay may land: the jitter covers the upper half of the
// step, so the largest random brings the delay to the step itself, give or take the rounding.
const ROUNDING_TOLERANCE_MS = 0.001;

// The steps of SETTINGS by counted attempt, from the first: doubled until the maximum stops them.
const STEPS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];

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
        STEPS_MS.forEach((stepMs, stepIndex) => {
            const countedAttempts = stepIndex + 1;

            expect(computeRetryDelayMs(countedAttempts, SETTINGS, () => 0)).to.equal(stepMs / 2);

            const largestDelayMs = computeRetryDelayMs(countedAttempts, SETTINGS, () => LARGEST_RANDOM);
            expect(largestDelayMs).to.be.closeTo(stepMs, ROUNDING_TOLERANCE_MS);
            expect(largestDelayMs).to.be.at.most(stepMs);
        });
    });

    it("draws the jitter from Math.random when no random source is passed", function () {
        const delayMs = computeRetryDelayMs(1, SETTINGS);

        expect(delayMs).to.be.at.least(500);
        expect(delayMs).to.be.below(1000);
    });
});
