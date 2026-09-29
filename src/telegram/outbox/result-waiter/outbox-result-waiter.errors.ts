import { RuntimeError } from "app/shared/errors";

export class OutboxResultTimeout extends RuntimeError {
    public static of(messageId: number, timeoutMs: number): OutboxResultTimeout {
        return new OutboxResultTimeout(`Outbox message ${messageId} did not finish within ${timeoutMs} ms.`, {
            messageId: messageId,
            timeoutMs: timeoutMs,
        });
    }
}
