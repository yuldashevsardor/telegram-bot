export type OutboxRetryDelaySettings = {
    // The step after the first counted attempt.
    firstDelayMs: number;
    // The cap of the step: the growth stops here.
    maxDelayMs: number;
    // How many times each further counted attempt multiplies the step.
    multiplier: number;
};
