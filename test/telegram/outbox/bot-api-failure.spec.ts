import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";
import { BotApiFailureClassifier, BotApiFailureKind, DEFAULT_RETRY_AFTER_SECONDS } from "app/telegram/outbox/bot-api-failure";

describe("Outbox Bot API failure classes", function () {
    const classifier = new BotApiFailureClassifier();

    it("takes a network error for transient", function () {
        const error = new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));

        expect(classifier.classify(error)).to.deep.equal({ kind: BotApiFailureKind.Transient });
    });

    it("takes every Telegram 5xx for transient", function () {
        for (const errorCode of [500, 502, 599]) {
            const error = telegramError(errorCode, "Internal Server Error");

            expect(classifier.classify(error), `code ${errorCode}`).to.deep.equal({
                kind: BotApiFailureKind.Transient,
            });
        }
    });

    it("does not take a code past the 5xx range for transient", function () {
        expect(classifier.classify(telegramError(600, "Unknown"))).to.deep.equal({
            kind: BotApiFailureKind.Unexpected,
        });
    });

    it("takes a 429 for flood with its retry_after", function () {
        const error = telegramError(429, "Too Many Requests: retry after 60", { retry_after: 60 });

        expect(classifier.classify(error)).to.deep.equal({ kind: BotApiFailureKind.Flood, retryAfterSeconds: 60 });
    });

    it("gives a 429 without retry_after the default pause", function () {
        const error = telegramError(429, "Too Many Requests");

        expect(classifier.classify(error)).to.deep.equal({
            kind: BotApiFailureKind.Flood,
            retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        });
        expect(DEFAULT_RETRY_AFTER_SECONDS).to.be.above(0);
    });

    it("gives a 429 with an unreadable or non-positive retry_after the default pause", function () {
        for (const retryAfter of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "soon"]) {
            const error = telegramError(429, "Too Many Requests", { retry_after: retryAfter as number });

            expect(classifier.classify(error), `retry_after ${String(retryAfter)}`).to.deep.equal({
                kind: BotApiFailureKind.Flood,
                retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
            });
        }
    });

    it("takes a 403 for undeliverable", function () {
        for (const description of ["Forbidden: bot was blocked by the user", "Forbidden: bot was kicked from the group chat"]) {
            expect(classifier.classify(telegramError(403, description)), description).to.deep.equal({
                kind: BotApiFailureKind.Undeliverable,
            });
        }
    });

    it("takes a 400 chat not found for undeliverable", function () {
        expect(classifier.classify(telegramError(400, "Bad Request: chat not found"))).to.deep.equal({
            kind: BotApiFailureKind.Undeliverable,
        });
    });

    it("takes a 400 other than chat not found for unexpected", function () {
        expect(classifier.classify(telegramError(400, "Bad Request: message text is empty"))).to.deep.equal({
            kind: BotApiFailureKind.Unexpected,
        });
    });

    it("takes chat not found under a code other than 400 for unexpected", function () {
        expect(classifier.classify(telegramError(404, "Bad Request: chat not found"))).to.deep.equal({
            kind: BotApiFailureKind.Unexpected,
        });
    });

    it("takes another 4xx for unexpected", function () {
        expect(classifier.classify(telegramError(401, "Unauthorized"))).to.deep.equal({
            kind: BotApiFailureKind.Unexpected,
        });
    });

    it("takes an error that is not grammY's for unexpected", function () {
        for (const error of [new Error("boom"), { error_code: 429, parameters: { retry_after: 5 } }, undefined]) {
            expect(classifier.classify(error)).to.deep.equal({ kind: BotApiFailureKind.Unexpected });
        }
    });
});

// An answer without parameters leaves the field out, as Telegram does.
function telegramError(errorCode: number, description: string, parameters?: ResponseParameters): GrammyError {
    const answer: ApiError = { ok: false, error_code: errorCode, description };

    if (parameters !== undefined) {
        answer.parameters = parameters;
    }

    return new GrammyError(`Call to 'sendMessage' failed! (${errorCode}: ${description})`, answer, "sendMessage", {
        chat_id: 1,
        text: "hello",
    });
}
