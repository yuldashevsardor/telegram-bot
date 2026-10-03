import { GrammyError } from "grammy";
import { injectable } from "inversify";
import { serializeError } from "serialize-error";
import { configValue } from "app/shared/config-value";
import type { OutboxJsonObject } from "app/telegram/outbox/store/outbox-store.types";

// What the bot token is replaced with.
const REDACTED_TOKEN = "***";

// The error of a failed attempt as its attempt keeps it: of an outbox send, and of an inbox handler.
@injectable()
export class OutboxErrorSerializer {
    public constructor(private readonly botToken: string = configValue("bot.token")) {}

    // The error serialized as the logger writes it (serializeError): the stack, the fields of the
    // answer that grammY keeps on its errors (error_code, description, parameters, method) and the
    // error an HttpError wraps. serializeError wraps a value that is not an Error into NonError. Two
    // things stay out:
    // - the payload of a GrammyError: a copy of the call. An outbox row holds the call already; an
    //   inbox row holds the update, and its attempt needs the error of the call, not the call;
    // - the bot token: the fetch error an HttpError wraps names the URL of the call, and the URL
    //   carries the token. grammY keeps it out of its own message, the serialized fields bring it
    //   back. It is replaced wherever it shows.
    public serialize(error: unknown): OutboxJsonObject {
        const serialized = serializeError(error);

        if (error instanceof GrammyError) {
            delete serialized["payload"];
        }

        const redactedJson = JSON.stringify(serialized).replaceAll(this.botToken, REDACTED_TOKEN);

        return JSON.parse(redactedJson) as OutboxJsonObject;
    }
}
