import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { Api, GrammyError, HttpError } from "grammy";
import type { ApiClientOptions } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";
import {
    DEFAULT_RETRY_AFTER_SECONDS,
    TelegramBotApiFailureClassifier,
} from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { PathFile } from "app/telegram/path-file/path-file";

const TOKEN = "123456789:unused";
// Nothing listens on port 1, so node-fetch fails to connect at once.
const UNREACHABLE_API_ROOT = "http://127.0.0.1:1";
const SHORT_TIMEOUT_SECONDS = 0.01;

describe("TelegramBotApiFailureClassifier", function () {
    const classifier = new TelegramBotApiFailureClassifier();

    it("takes a network error for transient", function () {
        const error = new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    it("takes a failed connection of grammY's own client for transient", async function () {
        const api = new Api(TOKEN, { apiRoot: UNREACHABLE_API_ROOT });
        const error = await callError(() => api.sendMessage(1, "hello"));

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    // The call may have reached Telegram: its retry can deliver the message twice, which the outbox
    // accepts (docs/architecture/outbox.md, "Error classes").
    it("takes a timeout of grammY for transient", async function () {
        const api = new Api(TOKEN, { fetch: neverAnswers(), timeoutSeconds: SHORT_TIMEOUT_SECONDS });
        const error = await callError(() => api.sendMessage(1, "hello"));

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    it("takes a file that is gone for unexpected, with no retry", async function () {
        const missingFilePath = join(tmpdir(), `missing-${randomUUID()}.ttf`);
        const api = new Api(TOKEN, { fetch: readsTheBody() });
        const error = await callError(() => api.sendDocument(1, new PathFile(missingFilePath)));

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Unexpected });
    });

    // node-fetch copies the code of the system error onto its FetchError, but not the syscall.
    it("keeps a network error with the code of a missing file transient", function () {
        const resolverFailure = systemError("request to https://api.telegram.org failed, reason: getaddrinfo ENOENT", {
            type: "system",
            code: "ENOENT",
            errno: "ENOENT",
        });
        const error = new HttpError("Network request for 'sendMessage' failed!", resolverFailure);

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    // Guards the syscall comparison of isMissingFile(). The input is made by hand: grammY with
    // node-fetch does not pass such an error on, its FetchError drops the syscall.
    it("keeps an ENOENT of a syscall other than open transient", function () {
        const missingSocket = systemError("connect ENOENT /run/proxy.sock", {
            code: "ENOENT",
            syscall: "connect",
            address: "/run/proxy.sock",
        });
        const error = new HttpError("Network request for 'sendMessage' failed!", missingSocket);

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    it("keeps a file that opens but cannot be read transient", async function () {
        const api = new Api(TOKEN, { fetch: readsTheBody() });
        const error = await callError(() => api.sendDocument(1, new PathFile(tmpdir())));

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    // A retry may open the file once descriptors are freed.
    it("keeps a file that cannot be opened for a while transient", function () {
        const outOfDescriptors = systemError("EMFILE: too many open files, open '/fonts/a.ttf'", {
            code: "EMFILE",
            syscall: "open",
            path: "/fonts/a.ttf",
        });
        const error = new HttpError("Network request for 'sendDocument' failed!", outOfDescriptors);

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Transient });
    });

    it("takes every Telegram 5xx for transient", function () {
        for (const errorCode of [500, 502, 599]) {
            const error = telegramError(errorCode, "Internal Server Error");

            expect(classifier.classify(error), `code ${errorCode}`).to.deep.equal({
                kind: TelegramBotApiFailureKind.Transient,
            });
        }
    });

    it("does not take a code past the 5xx range for transient", function () {
        expect(classifier.classify(telegramError(600, "Unknown"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes a 429 for flood with its retry_after", function () {
        const error = telegramError(429, "Too Many Requests: retry after 60", { retry_after: 60 });

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Flood, retryAfterSeconds: 60 });
    });

    it("gives a 429 without retry_after the default pause", function () {
        const error = telegramError(429, "Too Many Requests");

        expect(classifier.classify(error)).to.deep.equal({
            kind: TelegramBotApiFailureKind.Flood,
            retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        });
        expect(DEFAULT_RETRY_AFTER_SECONDS).to.be.above(0);
    });

    it("gives a 429 with an unreadable or non-positive retry_after the default pause", function () {
        for (const retryAfter of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "soon"]) {
            const error = telegramError(429, "Too Many Requests", { retry_after: retryAfter as number });

            expect(classifier.classify(error), `retry_after ${String(retryAfter)}`).to.deep.equal({
                kind: TelegramBotApiFailureKind.Flood,
                retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
            });
        }
    });

    it("takes a 403 for undeliverable", function () {
        for (const description of ["Forbidden: bot was blocked by the user", "Forbidden: bot was kicked from the group chat"]) {
            expect(classifier.classify(telegramError(403, description)), description).to.deep.equal({
                kind: TelegramBotApiFailureKind.Undeliverable,
            });
        }
    });

    it("takes a 400 about a chat the bot cannot reach for undeliverable", function () {
        for (const description of ["Bad Request: chat not found", "Bad Request: PEER_ID_INVALID", "Bad Request: user not found"]) {
            expect(classifier.classify(telegramError(400, description)), description).to.deep.equal({
                kind: TelegramBotApiFailureKind.Undeliverable,
            });
        }
    });

    it("takes a 400 of a group upgraded to a supergroup for undeliverable", function () {
        const error = telegramError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
            migrate_to_chat_id: -1001234567890,
        });

        expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Undeliverable });
    });

    it("takes a 400 of a malformed call for unexpected", function () {
        expect(classifier.classify(telegramError(400, "Bad Request: message text is empty"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes a reworded description of an unreachable chat for unexpected", function () {
        expect(classifier.classify(telegramError(400, "Bad Request: CHAT NOT FOUND"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes chat not found under a code other than 400 for unexpected", function () {
        expect(classifier.classify(telegramError(404, "Bad Request: chat not found"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes a 401 for unauthorized", function () {
        expect(classifier.classify(telegramError(401, "Unauthorized"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unauthorized,
        });
    });

    // Telegram answers a 404 to a token of a wrong format too, but such a token fails getMe when the
    // bot starts: a 404 while it runs is an unknown method, a bug of the call.
    it("takes a 404 for unexpected, not for unauthorized", function () {
        expect(classifier.classify(telegramError(404, "Not Found"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes another 4xx for unexpected", function () {
        expect(classifier.classify(telegramError(409, "Conflict: terminated by other getUpdates request"))).to.deep.equal({
            kind: TelegramBotApiFailureKind.Unexpected,
        });
    });

    it("takes an error that is not grammY's for unexpected", function () {
        for (const error of [new Error("boom"), { error_code: 429, parameters: { retry_after: 5 } }, undefined]) {
            expect(classifier.classify(error)).to.deep.equal({ kind: TelegramBotApiFailureKind.Unexpected });
        }
    });
});

// An error with the fields of a Node system error, made by hand for a shape grammY's own client does
// not produce on demand.
function systemError(message: string, fields: Record<string, string>): Error {
    return Object.assign(new Error(message), fields);
}

// The error grammY's own client throws for the call.
async function callError(call: () => Promise<unknown>): Promise<unknown> {
    try {
        await call();
    } catch (error) {
        return error;
    }

    return expect.fail("The call was expected to fail");
}

// A fetch whose answer never comes, so grammY's timeout ends the call.
function neverAnswers(): ApiClientOptions["fetch"] {
    return (() => new Promise(() => {})) as unknown as ApiClientOptions["fetch"];
}

// A fetch that reads the multipart body, which is where grammY opens the files of the call, and
// then never answers: the error of the file stream ends the call first.
function readsTheBody(): ApiClientOptions["fetch"] {
    const fetch = async (_url: string, init: { body: AsyncIterable<unknown> }): Promise<never> => {
        for await (const chunk of init.body) {
            void chunk;
        }

        return new Promise<never>(() => {});
    };

    return fetch as unknown as ApiClientOptions["fetch"];
}

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
