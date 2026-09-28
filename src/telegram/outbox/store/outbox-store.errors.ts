import { RuntimeError } from "app/shared/errors";

export class OutboxMessageNotProcessing extends RuntimeError {
    public static byId(messageId: number): OutboxMessageNotProcessing {
        return new OutboxMessageNotProcessing(
            `Outbox message ${messageId} is not processing: it is missing or was taken by another puller.`,
            {
                messageId: messageId,
            },
        );
    }
}
