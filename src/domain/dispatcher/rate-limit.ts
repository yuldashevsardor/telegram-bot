export type Rate = {
    number: number;
    interval: number;
};

export class RateLimit {
    private reserveTimeout: number | null = null;
    private readonly reserveDuration: number;

    public constructor(private readonly rate: Rate) {
        this.reserveDuration = this.rate.interval / this.rate.number;
    }

    public isFree(): boolean {
        return this.reserveTimeout === null || this.reserveTimeout < Date.now();
    }

    public reserve(): void {
        if (!this.isFree()) {
            throw new Error("Can't reserve until the rate limit is free");
        }

        this.reserveTimeout = Date.now() + this.reserveDuration;
    }
}
