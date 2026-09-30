import type { Api, RawApi } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { FileHelper } from "app/shared/fs/file-helper";
import type { Logger } from "app/platform/logger/logger";
import { PathFile } from "app/telegram/path-file/path-file";
import { deserialize } from "app/telegram/outbox/payload-codec/payload-codec";
import type { OutboxApiFactory } from "app/telegram/outbox/outbox-api-factory";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxJson, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// A Bot API method as the outbox calls it: by a name read from the row, with the payload alone.
type OutboxApiMethod = (payload: Record<string, unknown>) => Promise<OutboxJson>;

// Sends a pulled message: one Bot API call, and its outcome written to the outbox
// (docs/architecture/outbox.md, "Sending").
@injectable()
export class OutboxSender {
    private readonly api: Api;

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<OutboxFailureHandler>(Tokens.Bot.Outbox.FailureHandler) private readonly failureHandler: OutboxFailureHandler,
        @inject<OutboxApiFactory>(Tokens.Bot.Outbox.ApiFactory) apiFactory: OutboxApiFactory,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {
        this.api = apiFactory.create();
    }

    public async send(message: PulledOutboxMessage): Promise<void> {
        let payload: Record<string, unknown>;
        let response: OutboxJson;

        // A payload the codec cannot read is a corrupted row, and it fails as the call would.
        try {
            payload = deserialize(message.payload);
            response = await this.call(message.method, payload);
        } catch (error) {
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

    // The method comes from the row, so the compiler cannot check its name against RawApi: an
    // unknown one reaches Telegram and fails there. grammY binds an empty payload to its methods
    // without parameters (getMe, logOut and the like; createRawApi() in its core/client.js), so the
    // payload passed here would stand for the signal and fail the call. None of them is sent to a
    // chat, and every outbox message is. The result is Telegram's JSON.
    private call(method: string, payload: Record<string, unknown>): Promise<OutboxJson> {
        const apiMethod = this.api.raw[method as keyof RawApi] as unknown as OutboxApiMethod;

        return apiMethod(payload);
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
