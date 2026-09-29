import { RuntimeError } from "app/shared/errors";

export class OutboxMessageNotProcessing extends RuntimeError {
    public static byId(messageId: number): OutboxMessageNotProcessing {
        return new OutboxMessageNotProcessing(
            `Outbox message ${messageId} is not processing: the id is wrong, or the message is not pulled yet or already done.`,
            {
                messageId: messageId,
            },
        );
    }
}
