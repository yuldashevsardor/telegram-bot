export type RetryDelaySettings = {
    // The step after the first counted attempt.
    firstDelayMs: number;
    // The cap of the step: the doubling stops here.
    maxDelayMs: number;
};

// How long a message waits before its retry after a transient failure. countedAttempts is the
// number of attempts that count towards maxAttempts, the failed one included, so it starts at 1;
// a 429 is not counted. The step is firstDelayMs doubled with every further counted attempt,
// capped by maxDelayMs. The delay is a random point of the upper half of the step, the capped
// steps included: the chats that failed together, as in a Telegram outage, spread their retries
// out instead of coming back at the same moment, and a retry never comes sooner than half the
// step. random returns a number in [0, 1), as Math.random does.
export function computeRetryDelayMs(countedAttempts: number, settings: RetryDelaySettings, random: () => number = Math.random): number {
    const exponentialStepMs = settings.firstDelayMs * 2 ** (countedAttempts - 1);
    const stepMs = Math.min(exponentialStepMs, settings.maxDelayMs);
    const halfStepMs = stepMs / 2;

    return halfStepMs + random() * halfStepMs;
}
