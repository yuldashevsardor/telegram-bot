import type { FinishedOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

export type OutboxResultWaiterSettings = {
    // How long a caller waits for the outcome of its message.
    timeoutMs: number;
    // How often the ids still waited for are looked up, in case their notification was lost.
    pollIntervalMs: number;
};

// What the waiter needs from the outbox store; OutboxStore implements it.
export interface FinishedMessageSource {
    // The messages among messageIds that are in a final status.
    findFinished(messageIds: number[]): Promise<FinishedOutboxMessage[]>;

    // onFinished gets the id of every message that reaches a final status on any node. onListen is
    // called every time the listening starts: the first time and after a reconnect, since a
    // notification sent while the connection was down is lost. Resolves once the listening starts.
    listenForFinished(onFinished: (messageId: number) => void, onListen: () => void): Promise<void>;
}
