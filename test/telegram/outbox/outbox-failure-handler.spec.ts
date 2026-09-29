import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";
import { serializeError } from "serialize-error";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { RetryDelay } from "app/telegram/outbox/retry-delay/retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttempt, OutboxAttemptError, OutboxLease, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new RetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 60_000, multiplier: MULTIPLIER }, () => 0);
const WORKER = { host: "node-1", pid: 101, worker_id: "worker-1" };
const BOT_TOKEN = "123456:secret-bot-token";

type StoreCall =
    | { method: "retry"; lease: OutboxLease; error: OutboxAttemptError; delayMs: number }
    | { method: "markAsFailed" | "markAsFailedAndBlockChat"; lease: OutboxLease; error: OutboxAttemptError }
    | { method: "pause"; durationMs: number };

// Records what the handler asks of the store: which outcome is written is decided here, how it is
// written is pinned by the store spec.
class RecordingStore {
    public readonly calls: StoreCall[] = [];

    public async retry(lease: OutboxLease, error: OutboxAttemptError, delayMs: number): Promise<void> {
        this.calls.push({ method: "retry", lease, error, delayMs });
    }

    public async markAsFailed(lease: OutboxLease, error: OutboxAttemptError): Promise<void> {
        this.calls.push({ method: "markAsFailed", lease, error });
    }

    public async markAsFailedAndBlockChat(lease: OutboxLease, error: OutboxAttemptError): Promise<void> {
        this.calls.push({ method: "markAsFailedAndBlockChat", lease, error });
    }

    public async pause(durationMs: number): Promise<void> {
        this.calls.push({ method: "pause", durationMs });
    }
}

describe("OutboxFailureHandler", function () {
    let store: RecordingStore;
    let handler: OutboxFailureHandler;

    beforeEach(function () {
        store = new RecordingStore();
        handler = handlerAllowing(MAX_ATTEMPTS);
    });

    it("retries a transient failure after the delay of its counted attempt", async function () {
        const message = pulledAfter([TelegramBotApiFailureKind.Transient]);
        const error = networkError();

        await handler.handle(message, error);

        // The second counted attempt: the step is doubled once, and the delay is half of it.
        expect(store.calls).to.deep.equal([
            {
                method: "retry",
                lease: message,
                error: attemptError(error, TelegramBotApiFailureKind.Transient),
                delayMs: (FIRST_DELAY_MS * MULTIPLIER) / 2,
            },
        ]);
    });

    it("fails a transient failure of the last counted attempt and blocks its chat", async function () {
        const message = pulledAfter([TelegramBotApiFailureKind.Transient, TelegramBotApiFailureKind.Transient]);
        const error = networkError();

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            {
                method: "markAsFailedAndBlockChat",
                lease: message,
                error: attemptError(error, TelegramBotApiFailureKind.Transient),
            },
        ]);
    });

    it("does not count a flood of an earlier attempt towards the limit", async function () {
        const message = pulledAfter([
            TelegramBotApiFailureKind.Flood,
            TelegramBotApiFailureKind.Transient,
            TelegramBotApiFailureKind.Flood,
        ]);

        await handler.handle(message, networkError());

        expect(store.calls.map((call) => call.method)).to.deep.equal(["retry"]);
    });

    it("blocks the chat on the first transient failure when one attempt is allowed", async function () {
        await handlerAllowing(1).handle(pulledAfter([]), networkError());

        expect(store.calls.map((call) => call.method)).to.deep.equal(["markAsFailedAndBlockChat"]);
    });

    it("pauses the outbox for a flood before the message goes back to pending", async function () {
        const message = pulledAfter([TelegramBotApiFailureKind.Transient, TelegramBotApiFailureKind.Transient]);
        const error = telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 });

        await handler.handle(message, error);

        // The last counted attempt does not block on a flood: a flood does not count.
        expect(store.calls).to.deep.equal([
            { method: "pause", durationMs: 7_000 },
            { method: "retry", lease: message, error: attemptError(error, TelegramBotApiFailureKind.Flood), delayMs: 0 },
        ]);
    });

    it("fails an undeliverable message without blocking its chat", async function () {
        const message = pulledAfter([]);
        const error = telegramError(403, "Forbidden: bot was blocked by the user");

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            { method: "markAsFailed", lease: message, error: attemptError(error, TelegramBotApiFailureKind.Undeliverable) },
        ]);
    });

    it("fails an unexpected failure and blocks its chat", async function () {
        const message = pulledAfter([]);
        const error = telegramError(400, "Bad Request: message text is empty");

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            { method: "markAsFailedAndBlockChat", lease: message, error: attemptError(error, TelegramBotApiFailureKind.Unexpected) },
        ]);
    });

    it("keeps the whole error in the attempt: the stack and the fields of the answer", async function () {
        const error = telegramError(400, "Bad Request: message text is empty");

        await handler.handle(pulledAfter([]), error);

        const [call] = store.calls;

        expect(call).to.have.property("error").that.deep.includes({
            kind: TelegramBotApiFailureKind.Unexpected,
            name: "GrammyError",
            message: error.message,
            stack: error.stack,
            error_code: 400,
            description: "Bad Request: message text is empty",
            method: "sendMessage",
        });
    });

    it("keeps the bot token out of the attempt, the error an HttpError wraps included", async function () {
        const fetchError = new Error(
            `request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed, reason: getaddrinfo ENOTFOUND`,
        );

        await handler.handle(pulledAfter([]), new HttpError("Network request for 'sendMessage' failed!", fetchError));

        const serialized = JSON.stringify(store.calls[0]);

        expect(serialized).not.to.include(BOT_TOKEN);
        expect(serialized).to.include("https://api.telegram.org/bot***/sendMessage");
    });

    it("leaves the payload of the call out of the attempt", async function () {
        const answer: ApiError = { ok: false, error_code: 400, description: "Bad Request: message text is empty" };

        await handler.handle(
            pulledAfter([]),
            new GrammyError("Call to 'sendMessage' failed!", answer, "sendMessage", { chat_id: 1, text: "" }),
        );

        expect(store.calls[0]).to.have.property("error").that.not.to.have.property("payload");
    });

    it("keeps a thrown value that is not an Error as a serialized one", async function () {
        await handler.handle(pulledAfter([]), "socket closed");

        const [call] = store.calls;

        expect(call).to.have.property("error").that.deep.includes({
            kind: TelegramBotApiFailureKind.Unexpected,
            name: "NonError",
            message: "Non-error value: socket closed",
        });
    });

    function handlerAllowing(maxAttempts: number): OutboxFailureHandler {
        return new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            RETRY_DELAY,
            maxAttempts,
            BOT_TOKEN,
        );
    }
});

// A pulled message whose earlier attempts failed with the given kinds, and the open attempt of this
// send last.
function pulledAfter(earlierKinds: TelegramBotApiFailureKind[]): PulledOutboxMessage {
    const earlierAttempts: OutboxAttempt[] = earlierKinds.map((kind) => ({
        started_at: "2026-09-29T10:00:00.000000+00:00",
        worker: WORKER,
        finished_at: "2026-09-29T10:00:01.000000+00:00",
        error: { kind, message: "earlier failure" },
    }));
    const openAttempt: OutboxAttempt = { started_at: "2026-09-29T10:01:00.000000+00:00", worker: WORKER, finished_at: null, error: null };

    return {
        id: 7,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        chatId: 5_000_000_001,
        method: "sendMessage",
        payload: { text: "text" },
        priority: 0,
        attempts: [...earlierAttempts, openAttempt],
    };
}

// The attempt error of an error that carries neither the token nor a payload of its call.
function attemptError(error: unknown, kind: TelegramBotApiFailureKind): OutboxAttemptError {
    const serialized = serializeError(error);

    delete serialized["payload"];

    return Object.assign(serialized, { kind });
}

function networkError(): HttpError {
    return new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));
}

function telegramError(errorCode: number, description: string, parameters: ResponseParameters = {}): GrammyError {
    const answer: ApiError = { ok: false, error_code: errorCode, description, parameters };

    return new GrammyError(`Call to 'sendMessage' failed! (${errorCode}: ${description})`, answer, "sendMessage", {});
}
