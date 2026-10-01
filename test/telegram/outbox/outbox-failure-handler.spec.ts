import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import type { ApiError, ResponseParameters } from "grammy/types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { MS_PER_SECOND } from "app/shared/time";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxFailureHandler, UNAUTHORIZED_PAUSE_SECONDS } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type {
    ExpiredOutboxLease,
    OutboxAttemptError,
    OutboxJsonObject,
    OutboxLease,
    OutboxRetryOptions,
    PulledOutboxMessage,
} from "app/telegram/outbox/store/outbox-store.types";

const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new OutboxRetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 60_000, multiplier: MULTIPLIER }, () => 0);
// What the serializer of these specs turns any error into; its own spec pins what the real one does.
const SERIALIZED: OutboxJsonObject = { name: "Error", message: "serialized", kind: "overwritten" };

// What the attempt of an expired lease ends with. Spelled out rather than imported: the handler
// keeps it private, and the attempts it lands in are read by people.
const LEASE_EXPIRED: OutboxAttemptError = {
    name: "OutboxLeaseExpired",
    message: "The lease of the chat passed before its message was completed: the node that pulled it is presumed dead.",
    kind: TelegramBotApiFailureKind.Transient,
};

// What the attempt of a release on stop ends with, spelled out for the same reason.
const NODE_STOPPED: OutboxAttemptError = {
    name: "OutboxNodeStopped",
    message: "The node stopped before the call of the message finished: the message is released to any node.",
    kind: TelegramBotApiFailureKind.Transient,
};

type StoreCall =
    | { method: "retry"; lease: OutboxLease; error: OutboxAttemptError; delayMs: number; options?: OutboxRetryOptions }
    | { method: "markAsFailed" | "markAsFailedAndBlockChat"; lease: OutboxLease; error: OutboxAttemptError }
    | { method: "pause"; durationMs: number };

// Records what the handler asks of the store: which outcome is written is decided here, how it is
// written is pinned by the store spec.
class RecordingStore {
    public readonly calls: StoreCall[] = [];
    public expiredLeases: ExpiredOutboxLease[] = [];

    public async findExpiredLeases(): Promise<ExpiredOutboxLease[]> {
        return this.expiredLeases;
    }

    public async retry(lease: OutboxLease, error: OutboxAttemptError, delayMs: number, options?: OutboxRetryOptions): Promise<void> {
        // Only a call that passes options records them, so the other expectations need not spell them out.
        this.calls.push(
            options === undefined ? { method: "retry", lease, error, delayMs } : { method: "retry", lease, error, delayMs, options },
        );
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

type LogRecord = { message: string; payload: UnknownObject | undefined };

class RecordingLogger implements Logger {
    public readonly errors: LogRecord[] = [];

    public critical(): void {}

    public error(message: string, payload?: UnknownObject): void {
        this.errors.push({ message: message, payload: payload });
    }

    public warning(): void {}

    public info(): void {}

    public debug(): void {}
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

    describe("the recovery of expired leases", function () {
        it("retries the message of every expired lease as a transient failure after the delay of its attempt", async function () {
            const first = expiredAfter(7, 0);
            const second = expiredAfter(8, 1);
            store.expiredLeases = [first, second];

            await handler.recoverExpiredLeases();

            // The first attempt waits half of the first step, the second half of the doubled one.
            expect(store.calls).to.deep.equal([
                { method: "retry", lease: first, error: LEASE_EXPIRED, delayMs: FIRST_DELAY_MS / 2 },
                { method: "retry", lease: second, error: LEASE_EXPIRED, delayMs: (FIRST_DELAY_MS * MULTIPLIER) / 2 },
            ]);
        });

        it("fails the message of an expired lease on its last attempt and blocks its chat", async function () {
            const expired = expiredAfter(7, MAX_ATTEMPTS - 1);
            store.expiredLeases = [expired];

            await handler.recoverExpiredLeases();

            expect(store.calls).to.deep.equal([{ method: "markAsFailedAndBlockChat", lease: expired, error: LEASE_EXPIRED }]);
        });

        it("changes nothing when no lease has expired", async function () {
            await handler.recoverExpiredLeases();

            expect(store.calls).to.deep.equal([]);
        });
    });

    describe("a release on stop", function () {
        it("returns the message to pending with no delay and an attempt of the stopped node, then wakes the idle nodes", async function () {
            const message = pulledAfter(0);

            await handler.releaseOnStop(message);

            expect(store.calls).to.deep.equal([
                { method: "retry", lease: message, error: NODE_STOPPED, delayMs: 0, options: { shouldWakeIdleNodes: true } },
            ]);
        });

        it("blocks no chat, even on the last attempt", async function () {
            const message = pulledAfter(MAX_ATTEMPTS - 1);

            await handler.releaseOnStop(message);

            expect(store.calls).to.deep.equal([
                { method: "retry", lease: message, error: NODE_STOPPED, delayMs: 0, options: { shouldWakeIdleNodes: true } },
            ]);
        });
    });

    function handlerAllowing(maxAttempts: number): OutboxFailureHandler {
        return new OutboxFailureHandler(
            store as unknown as OutboxStore,
            new TelegramBotApiFailureClassifier(),
            RETRY_DELAY,
            new FixedSerializer(),
            logger,
            maxAttempts,
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

// A lease that passed before its message was completed, after earlierAttempts attempts.
function expiredAfter(id: number, earlierAttempts: number): ExpiredOutboxLease {
    return {
        id,
        lockToken: "9e4d1c7a-3b2f-4a6e-8c5d-1f0b2a3c4d5e",
        startedAt: "2026-09-29T10:02:00.000000+00:00",
        worker: null,
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

function telegramError(errorCode: number, description: string, parameters: ResponseParameters = {}): GrammyError {
    const answer: ApiError = { ok: false, error_code: errorCode, description, parameters };

    return new GrammyError(`Call to 'sendMessage' failed! (${errorCode}: ${description})`, answer, "sendMessage", {});
}
