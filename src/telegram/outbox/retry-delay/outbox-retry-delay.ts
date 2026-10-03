import { injectable } from "inversify";
import { configValue } from "app/shared/config-value";
import type { OutboxRetryDelaySettings } from "app/telegram/outbox/retry-delay/outbox-retry-delay.types";

// How long a message, or an inbox update, waits before its retry after a transient failure.
@injectable()
export class OutboxRetryDelay {
    public constructor(
        private readonly settings: OutboxRetryDelaySettings = configValue("outbox.retryDelay"),
        private readonly random: () => number = Math.random,
    ) {}

    // countedAttempts is the number of failed attempts the caller counts, the last one included, so
    // it starts at 1. The step is firstDelayMs multiplied by multiplier with every further counted
    // attempt, capped by maxDelayMs. The delay is a random point of the upper half of the step, the
    // capped steps included: the chats that failed together, as in a Telegram outage, spread their
    // retries out instead of coming back at the same moment, and a retry never comes sooner than
    // half the step. random returns a number in [0, 1), as Math.random does, so the delay is a
    // fraction of a millisecond as a rule: the caller rounds it if it needs whole milliseconds.
    public computeMs(countedAttempts: number): number {
        const exponentialStepMs = this.settings.firstDelayMs * this.settings.multiplier ** (countedAttempts - 1);
        const stepMs = Math.min(exponentialStepMs, this.settings.maxDelayMs);
        const halfStepMs = stepMs / 2;

        return halfStepMs + this.random() * halfStepMs;
    }
}
