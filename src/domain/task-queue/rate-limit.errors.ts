import { RuntimeError } from "app/common/errors";

export class RateLimitIsBusy extends RuntimeError {
    public static byRemainingTime(remainingTime: number): RateLimitIsBusy {
        return new RateLimitIsBusy({
            message: "Can't reserve until the rate limit is free.",
            payload: {
                remainingTime: remainingTime,
            },
        });
    }
}
