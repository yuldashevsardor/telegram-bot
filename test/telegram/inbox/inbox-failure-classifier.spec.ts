import { expect } from "chai";
import { HttpError } from "grammy";
import postgres from "postgres";
import { RuntimeError } from "app/shared/errors";
import { UserEditError } from "app/telegram/user/service/user-service.errors";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { InboxFailureClassifier } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import { OutboxResultTimeout } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";
import { telegramError } from "test/telegram/telegram-bot-api-failure-classifier.helper";

describe("InboxFailureClassifier", function () {
    const classifier = new InboxFailureClassifier(new TelegramBotApiFailureClassifier());

    describe("a Bot API error", function () {
        it("takes a network error and a Telegram 5xx for transient", function () {
            const networkError = new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));

            expect(classifier.classify(networkError)).to.equal(InboxFailureKind.Transient);
            expect(classifier.classify(telegramError(502, "Bad Gateway"))).to.equal(InboxFailureKind.Transient);
        });

        // Through the outbox neither reaches a handler: one that does came from a call that bypassed it.
        it("takes a 429 and a 401 for transient", function () {
            expect(classifier.classify(telegramError(429, "Too Many Requests: retry after 5"))).to.equal(InboxFailureKind.Transient);
            expect(classifier.classify(telegramError(401, "Unauthorized"))).to.equal(InboxFailureKind.Transient);
        });

        it("takes a chat the bot cannot reach for undeliverable", function () {
            expect(classifier.classify(telegramError(403, "Forbidden: bot was blocked by the user"))).to.equal(
                InboxFailureKind.Undeliverable,
            );
            expect(classifier.classify(telegramError(400, "Bad Request: chat not found"))).to.equal(InboxFailureKind.Undeliverable);
        });

        it("takes a malformed call and a file that is gone for unexpected", function () {
            const missingFile = Object.assign(new Error("ENOENT: no such file or directory, open '/fonts/a.ttf'"), {
                code: "ENOENT",
                syscall: "open",
            });

            expect(classifier.classify(telegramError(400, "Bad Request: message text is empty"))).to.equal(InboxFailureKind.Unexpected);
            expect(classifier.classify(new HttpError("Network request for 'sendDocument' failed!", missingFile))).to.equal(
                InboxFailureKind.Unexpected,
            );
        });
    });

    describe("a database or network error", function () {
        for (const code of [
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
        ]) {
            it(`takes a connection lost with ${code} for transient`, function () {
                const error = Object.assign(new Error(`write ${code} pgsql:5432`), { code: code });

                expect(classifier.classify(error)).to.equal(InboxFailureKind.Transient);
            });
        }

        // 08006 is connection_failure, 08P01 protocol_violation: the whole class is taken.
        for (const code of ["08006", "08P01", "57P01", "57P02", "57P03", "53300", "40001", "40P01"]) {
            it(`takes the SQLSTATE ${code} for transient`, function () {
                expect(classifier.classify(postgresError(code))).to.equal(InboxFailureKind.Transient);
            });
        }

        // 23505 is unique_violation; 22008, datetime_field_overflow, ends with the class of a connection
        // exception and is not one.
        for (const code of ["23505", "42P01", "22008"]) {
            it(`takes the SQLSTATE ${code} for unexpected`, function () {
                expect(classifier.classify(postgresError(code))).to.equal(InboxFailureKind.Unexpected);
            });
        }

        it("takes an error with another code for unexpected", function () {
            const error = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

            expect(classifier.classify(error)).to.equal(InboxFailureKind.Unexpected);
        });
    });

    describe("a wrapped error", function () {
        // UserService wraps a failed save of the user, made on every update, this way.
        it("takes a lost connection a caller wrapped for transient", function () {
            const wrapped = new UserEditError("Error in edit user", { dto: {}, cause: postgresError("57P01") });

            expect(classifier.classify(wrapped)).to.equal(InboxFailureKind.Transient);
        });

        it("reads the cause chain past more than one wrapper", function () {
            const lostConnection = Object.assign(new Error("write CONNECTION_CLOSED pgsql:5432"), { code: "CONNECTION_CLOSED" });
            const wrapped = new RuntimeError("The handler failed", new RuntimeError("The user was not saved", lostConnection));

            expect(classifier.classify(wrapped)).to.equal(InboxFailureKind.Transient);
        });

        it("takes the class of a wrapped Bot API error", function () {
            const wrapped = new RuntimeError("The reply was not sent", telegramError(403, "Forbidden: bot was blocked by the user"));

            expect(classifier.classify(wrapped)).to.equal(InboxFailureKind.Undeliverable);
        });

        it("takes a wrapped bug for unexpected", function () {
            const wrapped = new RuntimeError("The handler failed", new TypeError("Cannot read properties of undefined"));

            expect(classifier.classify(wrapped)).to.equal(InboxFailureKind.Unexpected);
        });

        it("ends a cause chain that refers back to itself", function () {
            const first = new Error("first");
            const second = new Error("second", { cause: first });
            first.cause = second;

            expect(classifier.classify(first)).to.equal(InboxFailureKind.Unexpected);
        });
    });

    describe("anything else", function () {
        it("takes a timeout waiting for the outbox for unexpected", function () {
            expect(classifier.classify(OutboxResultTimeout.of(1, 60_000))).to.equal(InboxFailureKind.Unexpected);
        });

        it("takes a bug and a value that is not an Error for unexpected", function () {
            for (const error of [new TypeError("Cannot read properties of undefined"), "failed", null, undefined, { code: 1 }]) {
                expect(classifier.classify(error), String(error)).to.equal(InboxFailureKind.Unexpected);
            }
        });
    });
});

// postgres.js builds the error from the fields of the server's answer, a constructor its typings do
// not declare.
function postgresError(code: string): Error {
    const PostgresError = postgres.PostgresError as unknown as new (fields: { message: string; code: string }) => Error;

    return new PostgresError({ message: `SQLSTATE ${code}`, code: code });
}
