export type Limit = {
    number: number;
    interval: number;
};

export class SlotManager {
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
            throw new Error("Can't reserve a slot until they're free");
        }

        this.reserveTimeout = Date.now() + this.reserveDuration;
    }
}
