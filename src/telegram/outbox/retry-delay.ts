import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";

export type RetryDelaySettings = {
    // The step after the first counted attempt.
    firstDelayMs: number;
    // The cap of the step: the growth stops here.
    maxDelayMs: number;
    // How many times each further counted attempt multiplies the step.
    multiplier: number;
};

// How long a message waits before its retry after a transient failure.
@injectable()
export class RetryDelay {
    public constructor(
        private readonly settings: RetryDelaySettings = configValue("outbox.retryDelay"),
        private readonly random: () => number = Math.random,
    ) {}

    // countedAttempts is the number of failed attempts the caller counts, the last one included, so
    // it starts at 1. The step is firstDelayMs multiplied by multiplier with every further counted
    // attempt, capped by maxDelayMs. The delay is a random point of the upper half of the step, the
    // capped steps included: the chats that failed together, as in a Telegram outage, spread their
    // retries out instead of coming back at the same moment, and a retry never comes sooner than
    // half the step. random returns a number in [0, 1), as Math.random does.
    public computeMs(countedAttempts: number): number {
        const exponentialStepMs = this.settings.firstDelayMs * this.settings.multiplier ** (countedAttempts - 1);
        const stepMs = Math.min(exponentialStepMs, this.settings.maxDelayMs);
        const halfStepMs = stepMs / 2;

        return halfStepMs + this.random() * halfStepMs;
    }
}
