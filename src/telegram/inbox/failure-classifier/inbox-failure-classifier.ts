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
// is transient as well. ENOTFOUND is among them although a mistyped host gives it for good: the DNS
// of compose answers it for a container that is restarting, and a mistyped host fails
// Database.check() at the start of the bot, before any update is handled.
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
    "ENOTFOUND",
]);

// The SQLSTATE class of a connection exception: the server lost or refused the connection.
const CONNECTION_EXCEPTION_CLASS = "08";

// The SQLSTATE codes of a server that stops or starts (admin_shutdown, crash_shutdown,
// cannot_connect_now), of one that has no connection slot left (too_many_connections, which a server
// just restarted under load gives) and of a transaction PostgreSQL rolled back for a concurrent one
// (serialization_failure, deadlock_detected): the same query passes once it runs again.
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["57P01", "57P02", "57P03", "53300", "40001", "40P01"]);

// Sorts the error an update handler failed with into InboxFailureKind (docs/architecture/inbox.md,
// "Error classes"). The error is the handler's own: grammY wraps it into a BotError, which the caller
// takes off first.
@injectable()
export class InboxFailureClassifier {
    public constructor(
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly botApiClassifier: TelegramBotApiFailureClassifier,
    ) {}

    // The first link of the cause chain that is not Unexpected decides: a wrapper says what failed,
    // the error it wraps says why. UserService wraps a failed save of the user, made on every update,
    // into UserCreateError or UserEditError with the error of the database as cause.
    public classify(error: unknown): InboxFailureKind {
        for (const link of this.causeChain(error)) {
            const kind = this.classifyLink(link);

            if (kind !== InboxFailureKind.Unexpected) {
                return kind;
            }
        }

        return InboxFailureKind.Unexpected;
    }

    private classifyLink(error: unknown): InboxFailureKind {
        if (error instanceof GrammyError || error instanceof HttpError) {
            return this.byBotApiFailure(this.botApiClassifier.classify(error).kind);
        }

        if (this.isTransientDatabaseOrNetworkFailure(error)) {
            return InboxFailureKind.Transient;
        }

        return InboxFailureKind.Unexpected;
    }

    // The error and the errors it wraps through cause, each once: a cause that refers back to an
    // earlier link ends the chain.
    private causeChain(error: unknown): unknown[] {
        // Stryker disable next-line ArrayDeclaration: `["Stryker was here"]` is equivalent: classify() takes the extra string for Unexpected and skips it, as it does any link that decides nothing
        const chain: unknown[] = [];
        let link = error;

        // Stryker disable next-line ConditionalExpression: `true` is equivalent: an undefined link joins the chain once, ends the loop at the next check through chain.includes(), and classify() takes it for Unexpected and skips it
        while (link !== undefined && !chain.includes(link)) {
            chain.push(link);
            link = link instanceof Error ? link.cause : undefined;
        }

        return chain;
    }

    // A flood and a revoked token are transient here: one that reaches a handler came from a call
    // that bypassed the outbox, and the update can be handled once it is over
    // (docs/architecture/inbox.md, "Error classes").
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
