import { RuntimeError } from "app/shared/errors";

export class OutboxResultTimeout extends RuntimeError {
    public static of(messageId: number, timeoutMs: number): OutboxResultTimeout {
        return new OutboxResultTimeout(`Outbox message ${messageId} did not finish within ${timeoutMs} ms.`, {
            messageId: messageId,
            timeoutMs: timeoutMs,
        });
    }
}

export class OutboxResultWaiterStopped extends RuntimeError {
    public static of(messageId: number): OutboxResultWaiterStopped {
        return new OutboxResultWaiterStopped(`The wait for outbox message ${messageId} was stopped.`, {
            messageId: messageId,
        });
    }
}
