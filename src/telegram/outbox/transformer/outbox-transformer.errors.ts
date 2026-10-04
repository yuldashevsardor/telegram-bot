import { RuntimeError } from "app/shared/errors";
import type { OutboxAttemptError } from "app/telegram/outbox/store/outbox-store.types";

export class OutboxMessageFailed extends RuntimeError {
    public static of(messageId: number, method: string, attemptError: OutboxAttemptError | null): OutboxMessageFailed {
        return new OutboxMessageFailed(`Outbox message ${messageId} (${method}) failed without an answer from Telegram.`, {
            messageId: messageId,
            method: method,
            attemptError: attemptError,
        });
    }
}

export class OutboxMessageSkipped extends RuntimeError {
    public static of(messageId: number, method: string): OutboxMessageSkipped {
        return new OutboxMessageSkipped(`Outbox message ${messageId} (${method}) was skipped and not sent.`, {
            messageId: messageId,
            method: method,
        });
    }
}
