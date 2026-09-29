import { RuntimeError } from "app/shared/errors";

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
