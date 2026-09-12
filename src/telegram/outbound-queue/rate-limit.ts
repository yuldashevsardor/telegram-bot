import { RateLimitIsBusy } from "app/telegram/outbound-queue/rate-limit.errors";
import { Limit } from "app/telegram/outbound-queue/rate-limit.types";

export class RateLimit {
    private reserveTimeout: number | null = null;
    private readonly reserveDuration: number;

    public constructor(private readonly limit: Limit) {
        this.reserveDuration = this.limit.interval / this.limit.number;
    }

    public isFree(): boolean {
        return this.reserveTimeout === null || this.reserveTimeout < Date.now();
    }

    public reserve(): void {
        if (!this.isFree()) {
            throw RateLimitIsBusy.byRemainingTime((this.reserveTimeout as number) - Date.now());
        }

        this.reserveTimeout = Date.now() + this.reserveDuration;
    }
}
