import { expect } from "chai";
import { HttpError } from "grammy";
import { MS_PER_SECOND } from "app/shared/time";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxFailureHandler, UNAUTHORIZED_PAUSE_SECONDS } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxLeaseRetrier } from "app/telegram/outbox/lease/outbox-lease-retrier";
import { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, OutboxJsonObject, OutboxLease, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import { telegramError } from "test/telegram/telegram-bot-api-failure-classifier.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new RetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 60_000, multiplier: MULTIPLIER }, () => 0);
// What the serializer of these specs turns any error into; its own spec pins what the real one does.
const SERIALIZED: OutboxJsonObject = { name: "Error", message: "serialized", kind: "overwritten" };

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

class FixedSerializer extends OutboxErrorSerializer {
    public constructor() {
        super("unused-token");
    }

    public override serialize(): OutboxJsonObject {
        return { ...SERIALIZED };
    }
}

describe("OutboxFailureHandler", function () {
    let store: RecordingStore;
    let logger: RecordingLogger;
    let handler: OutboxFailureHandler;

    beforeEach(function () {
        store = new RecordingStore();
        logger = new RecordingLogger();
        handler = handlerAllowing(MAX_ATTEMPTS);
    });

    it("retries a transient failure after the delay of its attempt", async function () {
        const message = pulledAfter(1);

        await handler.handle(message, networkError());

        // The second attempt: the step is doubled once, and the delay is half of it.
        expect(store.calls).to.deep.equal([
            {
                method: "retry",
                lease: message,
                error: attemptError(TelegramBotApiFailureKind.Transient),
                delayMs: (FIRST_DELAY_MS * MULTIPLIER) / 2,
            },
        ]);
    });

    it("fails a transient failure of the last attempt and blocks its chat", async function () {
        const message = pulledAfter(MAX_ATTEMPTS - 1);

        await handler.handle(message, networkError());

        expect(store.calls).to.deep.equal([
            { method: "markAsFailedAndBlockChat", lease: message, error: attemptError(TelegramBotApiFailureKind.Transient) },
        ]);
    });

    it("blocks the chat on the first transient failure when one attempt is allowed", async function () {
        await handlerAllowing(1).handle(pulledAfter(0), networkError());

        expect(store.calls.map((call) => call.method)).to.deep.equal(["markAsFailedAndBlockChat"]);
    });

    it("pauses the outbox for a flood before the message goes back to pending, even on the last attempt", async function () {
        const message = pulledAfter(MAX_ATTEMPTS - 1);

        await handler.handle(message, telegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }));

        expect(store.calls).to.deep.equal([
            { method: "pause", durationMs: 7_000 },
            { method: "retry", lease: message, error: attemptError(TelegramBotApiFailureKind.Flood), delayMs: 0 },
        ]);
    });

    it("pauses the outbox for a 401 before the message goes back to pending, even on the last attempt", async function () {
        const message = pulledAfter(MAX_ATTEMPTS - 1);

        await handler.handle(message, telegramError(401, "Unauthorized"));

        expect(store.calls).to.deep.equal([
            { method: "pause", durationMs: UNAUTHORIZED_PAUSE_SECONDS * MS_PER_SECOND },
            { method: "retry", lease: message, error: attemptError(TelegramBotApiFailureKind.Unauthorized), delayMs: 0 },
        ]);
    });

    it("logs an unauthorized failure as an error: no blocked chat shows it", async function () {
        const message = pulledAfter(0);

        await handler.handle(message, telegramError(401, "Unauthorized"));

        expect(logger.errors).to.deep.equal([
            {
                message: "The Bot API refuses the bot token: the outbox is paused.",
                payload: {
                    messageId: message.id,
                    pauseSeconds: UNAUTHORIZED_PAUSE_SECONDS,
                    cause: attemptError(TelegramBotApiFailureKind.Unauthorized),
                },
            },
        ]);
    });

    it("logs no error of its own for a flood or an unexpected failure", async function () {
        await handler.handle(pulledAfter(0), telegramError(400, "Bad Request: message text is empty"));
        await handler.handle(pulledAfter(0), telegramError(429, "Too Many Requests", { retry_after: 1 }));

        expect(logger.errors).to.deep.equal([]);
    });

    it("fails an undeliverable message without blocking its chat", async function () {
        const message = pulledAfter(0);

        await handler.handle(message, telegramError(403, "Forbidden: bot was blocked by the user"));

        expect(store.calls).to.deep.equal([
            { method: "markAsFailed", lease: message, error: attemptError(TelegramBotApiFailureKind.Undeliverable) },
        ]);
    });

    it("fails an unexpected failure and blocks its chat", async function () {
        const message = pulledAfter(0);

        await handler.handle(message, telegramError(400, "Bad Request: message text is empty"));

        expect(store.calls).to.deep.equal([
            { method: "markAsFailedAndBlockChat", lease: message, error: attemptError(TelegramBotApiFailureKind.Unexpected) },
        ]);
    });

    function handlerAllowing(maxAttempts: number): OutboxFailureHandler {
        return new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            new OutboxLeaseRetrier(store as unknown as OutboxStore, RETRY_DELAY, maxAttempts),
            new FixedSerializer(),
            logger,
        );
    }
});

function pulledAfter(earlierAttempts: number): PulledOutboxMessage {
    return {
        id: 7,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        startedAt: "2026-09-29T10:01:00.000000+00:00",
        worker: { host: "node-1", pid: 101, workerId: "worker-1" },
        chatId: 5_000_000_001,
        method: "sendMessage",
        payload: { text: "text" },
        priority: 0,
        earlierAttempts,
    };
}

// The serialized error with the class of the failure over its own kind field.
function attemptError(kind: TelegramBotApiFailureKind): OutboxAttemptError {
    return { name: "Error", message: "serialized", kind };
}

function networkError(): HttpError {
    return new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"));
}
