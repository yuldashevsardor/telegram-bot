import { RuntimeError } from "app/shared/errors";

export class BotLimitsRowMissing extends RuntimeError {
    public static create(): BotLimitsRowMissing {
        return new BotLimitsRowMissing(
            "The row of telegram_bot_limits is missing: the migration inserts it, and without it the outbox pulls nothing and cannot pause.",
        );
    }
}

export class InvalidPullLimit extends RuntimeError {
    public static of(limit: number): InvalidPullLimit {
        return new InvalidPullLimit(`An outbox pull of ${limit} messages is not a whole number from 1 to Number.MAX_SAFE_INTEGER.`, {
            limit: limit,
        });
    }
}

export class InvalidPauseDuration extends RuntimeError {
    public static of(durationMs: number): InvalidPauseDuration {
        return new InvalidPauseDuration(`An outbox pause of ${durationMs} ms is not a duration from 0 to Number.MAX_SAFE_INTEGER ms.`, {
            durationMs: durationMs,
        });
    }
}

export class OutboxMessageNotProcessing extends RuntimeError {
    public static byId(messageId: number): OutboxMessageNotProcessing {
        return new OutboxMessageNotProcessing(
            `Outbox message ${messageId} is not the message its lease holds: the id is missing or names another message of the leased chat.`,
            {
                messageId: messageId,
            },
        );
    }
}
