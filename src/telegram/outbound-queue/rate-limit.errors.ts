import { RuntimeError } from "app/common/errors";

export class RateLimitIsBusy extends RuntimeError {
    public static byRemainingTime(remainingTime: number): RateLimitIsBusy {
        return new RateLimitIsBusy("Can't reserve until the rate limit is free.", {
            remainingTime: remainingTime,
        });
    }
}
