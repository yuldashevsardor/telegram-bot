import { GrammyError, HttpError } from "grammy";
import { inject, injectable } from "inversify";
import postgres from "postgres";
import { Tokens } from "app/shared/tokens";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";

// The codes of an error that says the database or the way to it went away, not that the query was
// wrong. postgres.js gives the first three to a query its own connection lost (Errors.connection()
// in its src/errors.js); the rest are the codes of the Node socket it passes on as they are, when the
// connection cannot be opened or breaks. A socket error of another client is a network error, which
// is transient as well.
const LOST_CONNECTION_CODES: ReadonlySet<string> = new Set([
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
]);

// The SQLSTATE class of a connection exception: the server lost or refused the connection.
const CONNECTION_EXCEPTION_CLASS = "08";

// The SQLSTATE codes of a server that stops or starts (admin_shutdown, crash_shutdown,
// cannot_connect_now) and of a transaction PostgreSQL rolled back for a concurrent one
// (serialization_failure, deadlock_detected): the same query passes once it runs again.
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["57P01", "57P02", "57P03", "40001", "40P01"]);

// Sorts the error an update handler failed with into InboxFailureKind (docs/architecture/inbox.md,
// "Error classes"). The error is the handler's own: grammY wraps it into a BotError, which the caller
// takes off first.
@injectable()
export class InboxFailureClassifier {
    public constructor(
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly botApiClassifier: TelegramBotApiFailureClassifier,
    ) {}

    public classify(error: unknown): InboxFailureKind {
        if (error instanceof GrammyError || error instanceof HttpError) {
            return this.byBotApiFailure(this.botApiClassifier.classify(error).kind);
        }

        if (this.isTransientDatabaseOrNetworkFailure(error)) {
            return InboxFailureKind.Transient;
        }

        return InboxFailureKind.Unexpected;
    }

    // A flood and a revoked token are transient here. Through the outbox neither reaches a handler:
    // the outbox waits a 429 out and pauses on a 401 itself. One that reaches it came from a call
    // that bypassed the outbox, and the update can be handled once the pause or the token outage is
    // over.
    private byBotApiFailure(kind: TelegramBotApiFailureKind): InboxFailureKind {
        switch (kind) {
            case TelegramBotApiFailureKind.Transient:
            case TelegramBotApiFailureKind.Flood:
            case TelegramBotApiFailureKind.Unauthorized:
                return InboxFailureKind.Transient;
            case TelegramBotApiFailureKind.Undeliverable:
                return InboxFailureKind.Undeliverable;
            case TelegramBotApiFailureKind.Unexpected:
                return InboxFailureKind.Unexpected;
        }
    }

    // Only the error itself is read, not its cause: an error a caller wrapped is unexpected.
    private isTransientDatabaseOrNetworkFailure(error: unknown): boolean {
        if (error instanceof postgres.PostgresError) {
            return error.code.startsWith(CONNECTION_EXCEPTION_CLASS) || TRANSIENT_SQLSTATES.has(error.code);
        }

        if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
            return false;
        }

        return LOST_CONNECTION_CODES.has(error.code);
    }
}
