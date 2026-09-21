import { RateLimitIsBusy } from "app/telegram/outbound-queue/rate-limit/rate-limit.errors";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";

export class RateLimit {
    private reserveTimeout: number | null = null;
    private readonly reserveDuration: number;

    public constructor(private readonly limit: Limit) {
        this.reserveDuration = this.limit.interval / this.limit.number;
    }

    public isFree(): boolean {
        // Stryker disable next-line EqualityOperator: `<=` is equivalent: the cooldown ends a millisecond earlier, and both variants respect the limit
        return this.reserveTimeout === null || this.reserveTimeout < Date.now();
    }

    public reserve(): void {
        if (!this.isFree()) {
            throw RateLimitIsBusy.byRemainingTime((this.reserveTimeout as number) - Date.now());
        }

        this.reserveTimeout = Date.now() + this.reserveDuration;
    }
}
