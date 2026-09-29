import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { FinishedOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import type { OutboxFinishedMessageReader } from "app/telegram/outbox/outbox-finished-message-reader";
import type { OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import { OutboxResultTimeout, OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";

type PendingResult = {
    promise: Promise<FinishedOutboxMessage>;
    resolve: (message: FinishedOutboxMessage) => void;
    reject: (error: Error) => void;
    timeoutTimer: NodeJS.Timeout;
};

// Waits on this node for the outcome of an outbox message, whichever node sends it: a notification
// settles a wait at once, and a poll settles the waits whose notification was lost
// (docs/architecture/outbox.md, "Waiting for the result").
@injectable()
export class OutboxResultWaiter {
    private readonly pendingResults = new Map<number, PendingResult>();
    private hasStartedListening = false;
    private isPolling = false;
    // A poll asked for while another one runs, which the running one may predate.
    private shouldPollAgain = false;
    private pollTimer: NodeJS.Timeout | undefined;

    public constructor(
        @inject<OutboxFinishedMessageReader>(Tokens.Bot.Outbox.Result.Reader) private readonly reader: OutboxFinishedMessageReader,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly settings: OutboxResultWaiterSettings = configValue("outbox.resultWaiter"),
    ) {}

    // Resolves with the message once it is in a final status, or rejects with OutboxResultTimeout
    // after timeoutMs; the id is forgotten either way. A second wait for an id still waited for gets
    // the same promise, and its timeout runs from the first wait.
    public wait(messageId: number): Promise<FinishedOutboxMessage> {
        const pendingResult = this.pendingResults.get(messageId);

        if (pendingResult !== undefined) {
            return pendingResult.promise;
        }

        const { promise, resolve, reject } = Promise.withResolvers<FinishedOutboxMessage>();
        const timeoutTimer = setTimeout(() => {
            this.forget(messageId);
            reject(OutboxResultTimeout.of(messageId, this.settings.timeoutMs));
        }, this.settings.timeoutMs);

        this.pendingResults.set(messageId, { promise: promise, resolve: resolve, reject: reject, timeoutTimer: timeoutTimer });
        this.listen();
        this.startPolling();

        return promise;
    }

    // Rejects every pending wait with OutboxResultWaiterStopped and clears the timers, so a node
    // that shuts down neither polls a closed database nor is held up by a wait. The listening ends
    // with Database.close(). A wait started afterwards works as before.
    public stop(): void {
        for (const [messageId, pendingResult] of this.pendingResults) {
            this.forget(messageId);
            pendingResult.reject(OutboxResultWaiterStopped.of(messageId));
        }
    }

    // Started once, by the first wait. postgres.js keeps the listener of a failed LISTEN and
    // subscribes it again when its listening connection closes, so a second call would add a second
    // listener rather than retry (listen() in postgres.js src/index.js). Until then the poll serves.
    private listen(): void {
        if (this.hasStartedListening) {
            return;
        }

        this.hasStartedListening = true;

        this.reader
            .listen(
                (messageId) => void this.onFinished(messageId),
                () => void this.pollOnListenStart(),
            )
            .catch((error: unknown) => {
                this.logger.warning("Listening for finished outbox messages failed, the waits rely on the poll.", { cause: error });
            });
    }

    // A poll that runs when the listening starts may have read the table before the LISTEN, and so
    // miss a message finished in between: a fresh one follows it.
    private async pollOnListenStart(): Promise<void> {
        if (this.isPolling) {
            this.shouldPollAgain = true;

            return;
        }

        await this.poll();
    }

    // Every node hears every message; only the ones waited for here are read.
    private async onFinished(messageId: number): Promise<void> {
        if (!this.pendingResults.has(messageId)) {
            return;
        }

        await this.settleFinished([messageId]);
    }

    // The poll runs only while an id is waited for.
    private startPolling(): void {
        if (this.pollTimer !== undefined) {
            return;
        }

        this.pollTimer = setInterval(() => void this.poll(), this.settings.pollIntervalMs);
    }

    // One query for every id waited for. A tick that comes while the previous poll is still running
    // is skipped, so a slow database does not pile the polls up.
    private async poll(): Promise<void> {
        if (this.isPolling || this.pendingResults.size === 0) {
            return;
        }

        this.isPolling = true;

        try {
            await this.settleFinished([...this.pendingResults.keys()]);
        } finally {
            this.isPolling = false;
        }

        if (this.shouldPollAgain) {
            this.shouldPollAgain = false;
            await this.poll();
        }
    }

    // A failed read is left to the next poll.
    private async settleFinished(messageIds: number[]): Promise<void> {
        let finishedMessages: FinishedOutboxMessage[];

        try {
            finishedMessages = await this.reader.find(messageIds);
        } catch (error) {
            this.logger.warning("Reading finished outbox messages failed, the next poll tries again.", {
                messageIds: messageIds,
                cause: error,
            });

            return;
        }

        for (const message of finishedMessages) {
            this.settle(message);
        }
    }

    // A message no longer waited for is left alone: its wait has timed out, or a notification and a
    // poll both found it.
    private settle(message: FinishedOutboxMessage): void {
        const pendingResult = this.pendingResults.get(message.id);

        if (pendingResult === undefined) {
            return;
        }

        this.forget(message.id);
        pendingResult.resolve(message);
    }

    private forget(messageId: number): void {
        clearTimeout(this.pendingResults.get(messageId)?.timeoutTimer);
        this.pendingResults.delete(messageId);

        if (this.pendingResults.size === 0) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }
}
