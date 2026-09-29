import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { RetryDelay } from "app/telegram/outbox/retry-delay/retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, OutboxLease, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new RetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 60_000, multiplier: MULTIPLIER }, () => 0);

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

class RecordingLogger implements Logger {
    public readonly errors: Array<{ message: string; payload: UnknownObject | undefined }> = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(): void {}

    public info(): void {}

    public debug(): void {}
}

describe("OutboxFailureHandler", function () {
    let store: RecordingStore;
    let logger: RecordingLogger;
    let handler: OutboxFailureHandler;

    beforeEach(function () {
        store = new RecordingStore();
        logger = new RecordingLogger();
        handler = new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            RETRY_DELAY,
            logger,
            MAX_ATTEMPTS,
        );
    });

    it("retries a transient failure after the delay of its counted attempt", async function () {
        const message = pulled(1);
        const error = networkError();

        await handler.handle(message, error);

        // The second counted attempt: the step is doubled once, and the delay is half of it.
        expect(store.calls).to.deep.equal([
            {
                method: "retry",
                lease: message,
                error: { kind: TelegramBotApiFailureKind.Transient, message: error.message },
                delayMs: (FIRST_DELAY_MS * MULTIPLIER) / 2,
            },
        ]);
    });

    it("fails a transient failure of the last counted attempt and blocks its chat", async function () {
        const message = pulled(MAX_ATTEMPTS - 1);
        const error = networkError();

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            {
                method: "markAsFailedAndBlockChat",
                lease: message,
                error: { kind: TelegramBotApiFailureKind.Transient, message: error.message },
            },
        ]);
    });

    it("blocks the chat on the first transient failure when one attempt is allowed", async function () {
        const single = new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            RETRY_DELAY,
            logger,
            1,
        );

        await single.handle(pulled(0), networkError());

        expect(store.calls.map((call) => call.method)).to.deep.equal(["markAsFailedAndBlockChat"]);
    });

    it("pauses the outbox for a flood before the message goes back to pending", async function () {
        const message = pulled(MAX_ATTEMPTS - 1);
        const error = telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 });

        await handler.handle(message, error);

        // The last counted attempt does not block on a flood: a flood does not count.
        expect(store.calls).to.deep.equal([
            { method: "pause", durationMs: 7_000 },
            {
                method: "retry",
                lease: message,
                error: { kind: TelegramBotApiFailureKind.Flood, message: error.message },
                delayMs: 0,
            },
        ]);
    });

    it("fails an undeliverable message without blocking its chat", async function () {
        const message = pulled(0);
        const error = telegramError(403, "Forbidden: bot was blocked by the user");

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            {
                method: "markAsFailed",
                lease: message,
                error: { kind: TelegramBotApiFailureKind.Undeliverable, message: error.message },
            },
        ]);
    });

    it("fails an unexpected failure and blocks its chat", async function () {
        const message = pulled(0);
        const error = telegramError(400, "Bad Request: message text is empty");

        await handler.handle(message, error);

        expect(store.calls).to.deep.equal([
            {
                method: "markAsFailedAndBlockChat",
                lease: message,
                error: { kind: TelegramBotApiFailureKind.Unexpected, message: error.message },
            },
        ]);
        expect(logger.errors).to.deep.equal([
            { message: "Outbox send failed with an unexpected error.", payload: { messageId: message.id, cause: error } },
        ]);
    });

    it("logs the error of no class but the unexpected one", async function () {
        await handler.handle(pulled(0), networkError());
        await handler.handle(pulled(MAX_ATTEMPTS - 1), networkError());
        await handler.handle(pulled(0), telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }));
        await handler.handle(pulled(0), telegramError(403, "Forbidden: bot was blocked by the user"));

        expect(logger.errors).to.deep.equal([]);
    });

    it("records a thrown value that is not an Error as its string", async function () {
        await handler.handle(pulled(0), "socket closed");

        expect(store.calls).to.deep.equal([
            {
                method: "markAsFailedAndBlockChat",
                lease: pulled(0),
                error: { kind: TelegramBotApiFailureKind.Unexpected, message: "socket closed" },
            },
        ]);
    });
});

function pulled(countedFailures: number): PulledOutboxMessage {
    return {
        id: 7,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        chatId: 5_000_000_001,
        method: "sendMessage",
        payload: { text: "text" },
        priority: 0,
        countedFailures,
    };
}

function networkError(): HttpError {
    return new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));
}

function telegramError(errorCode: number, description: string, parameters: ResponseParameters = {}): GrammyError {
    const answer: ApiError = { ok: false, error_code: errorCode, description, parameters };

    return new GrammyError(`Call to 'sendMessage' failed! (${errorCode}: ${description})`, answer, "sendMessage", {});
}
