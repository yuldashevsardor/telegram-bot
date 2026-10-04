import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Logger } from "app/platform/logger/logger";
import { HttpError } from "grammy";
import { PathFile } from "app/telegram/path-file/path-file";
import { deserialize } from "app/telegram/outbox/payload-codec/payload-codec";
import type { OutboxSender } from "app/telegram/outbox/outbox-sender";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import type { OutboxLeaseReleaser } from "app/telegram/outbox/lease/outbox-lease-releaser";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxJson, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// Takes a pulled message to its outcome: the call, then the outcome written to the outbox and the
// files of a sent message removed (docs/architecture/outbox.md, "Sending").
@injectable()
export class OutboxMessageProcessor {
    public constructor(
        @inject<OutboxSender>(Tokens.Bot.Outbox.Sender) private readonly sender: OutboxSender,
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxFailureHandler>(Tokens.Bot.Outbox.FailureHandler) private readonly failureHandler: OutboxFailureHandler,
        @inject<OutboxLeaseReleaser>(Tokens.Bot.Outbox.Lease.Releaser) private readonly leaseReleaser: OutboxLeaseReleaser,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {}

    // signal aborts the call when the node stops; the message is released then instead of failing
    // (docs/architecture/outbox.md, "Release on stop").
    public async process(message: PulledOutboxMessage, signal: AbortSignal): Promise<void> {
        let payload: Record<string, unknown>;
        let response: OutboxJson;

        // A payload the codec cannot read is a corrupted row, and it fails as the call would.
        try {
            payload = deserialize(message.payload);
            response = await this.sender.send(message.method, payload, signal);
        } catch (error) {
            // grammY throws an aborted call as an HttpError, a transient failure: handled as one, it
            // would wait for a retry delay, or block its chat on the last attempt, for a stop that
            // says nothing about the message. An answer of Telegram that came with the abort, a
            // GrammyError, is handled as any other. The call has settled by now, so the release
            // cannot let it reach Telegram after the next message of its chat.
            if (signal.aborted && error instanceof HttpError) {
                await this.leaseReleaser.releaseOnStop(message);
                return;
            }

            // Not wrapped: the serializer of the attempt drops the payload of a GrammyError only at
            // the top level.
            await this.failureHandler.handle(message, error);
            return;
        }

        const isDone = await this.store.markAsDone(message, response);

        // A fenced completion: another completion has changed the message already, a recovery that
        // put it back to pending or failed it, or the node that finished it. Its files are not this
        // completion's to remove.
        if (!isDone) {
            return;
        }

        await this.removeFiles(message, payload);
    }

    // Only a done message gives its files up: a failed one may be put back to pending by hand and
    // sent again (docs/architecture/outbox.md, "Sending"). The message is sent whatever the removal
    // ends with, so a file left behind is only logged.
    private async removeFiles(message: PulledOutboxMessage, payload: Record<string, unknown>): Promise<void> {
        for (const file of this.findFiles(payload)) {
            try {
                await FileHelper.remove(file.path);
            } catch (error) {
                this.logger.warning("The file of a sent outbox message was not removed.", {
                    messageId: message.id,
                    path: file.path,
                    cause: error,
                });
            }
        }
    }

    // Object.values() walks an array by its items as well.
    private findFiles(value: unknown): PathFile[] {
        if (value instanceof PathFile) {
            return [value];
        }

        if (typeof value !== "object" || value === null) {
            return [];
        }

        return Object.values(value).flatMap((item: unknown) => this.findFiles(item));
    }
}
