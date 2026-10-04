import fs from "fs/promises";
import os from "os";
import path from "path";
import { expect } from "chai";
import { GrammyError, HttpError } from "grammy";
import { RemoveFailed } from "app/shared/fs/file-helper.errors";
import { PathFile } from "app/telegram/path-file/path-file";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import type { OutboxLeaseReleaser } from "app/telegram/outbox/lease/outbox-lease-releaser";
import { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import type { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import { InvalidFileMarker } from "app/telegram/outbox/payload-codec/payload-codec.errors";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxJson, OutboxLease, OutboxPayload, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const CHAT_ID = 5_000_000_001;
const RESPONSE: OutboxJson = { message_id: 42, chat: { id: CHAT_ID } };

type SenderCall = { method: string; payload: Record<string, unknown>; signal: AbortSignal };

// Answers every call with the response, or throws the error when one is set.
class FakeSender {
    public readonly calls: SenderCall[] = [];
    public error: unknown = undefined;

    public async send(method: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<OutboxJson> {
        this.calls.push({ method, payload, signal });

        if (this.error !== undefined) {
            throw this.error;
        }

        return RESPONSE;
    }
}

class RecordingStore {
    public readonly done: Array<{ lease: OutboxLease; response: OutboxJson }> = [];
    // What markAsDone() answers: false stands for a fenced completion.
    public isDone = true;

    public async markAsDone(lease: OutboxLease, response: OutboxJson): Promise<boolean> {
        this.done.push({ lease, response });

        return this.isDone;
    }
}

class RecordingFailureHandler {
    public readonly calls: Array<{ message: PulledOutboxMessage; error: unknown }> = [];

    public async handle(message: PulledOutboxMessage, error: unknown): Promise<void> {
        this.calls.push({ message, error });
    }
}

class RecordingLeaseReleaser {
    public readonly released: OutboxLease[] = [];

    public async releaseOnStop(lease: OutboxLease): Promise<void> {
        this.released.push(lease);
    }
}

describe("OutboxMessageProcessor", function () {
    let sender: FakeSender;
    let store: RecordingStore;
    let failureHandler: RecordingFailureHandler;
    let leaseReleaser: RecordingLeaseReleaser;
    let logger: RecordingLogger;
    let processor: OutboxMessageProcessor;
    let directory: string;
    // The signal of a call nothing aborts.
    let signal: AbortSignal;

    beforeEach(async function () {
        sender = new FakeSender();
        store = new RecordingStore();
        failureHandler = new RecordingFailureHandler();
        leaseReleaser = new RecordingLeaseReleaser();
        logger = new RecordingLogger();
        processor = new OutboxMessageProcessor(
            sender as unknown as OutboxSender,
            store as unknown as OutboxStore,
            failureHandler as unknown as OutboxFailureHandler,
            leaseReleaser as unknown as OutboxLeaseReleaser,
            logger,
        );
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "outbox-message-processor-"));
        signal = new AbortController().signal;
    });

    afterEach(async function () {
        await fs.rm(directory, { recursive: true, force: true });
    });

    it("sends the method of the message with its payload rebuilt, the files included", async function () {
        const documentPath = await createFile("font.ttf");

        await processor.process(pulled("sendDocument", { chat_id: CHAT_ID, document: new PathFile(documentPath, "font.ttf") }), signal);

        expect(sender.calls).to.have.lengthOf(1);
        const [{ method, payload, signal: callSignal }] = sender.calls as [SenderCall];
        expect(method).to.equal("sendDocument");
        expect(callSignal).to.equal(signal);
        expect(payload).to.have.property("chat_id", CHAT_ID);
        expect(payload)
            .to.have.property("document")
            .that.is.instanceOf(PathFile)
            .and.includes({ path: documentPath, filename: "font.ttf" });
    });

    it("marks the message done with the response of the call", async function () {
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await processor.process(message, signal);

        expect(store.done).to.deep.equal([{ lease: message, response: RESPONSE }]);
        expect(failureHandler.calls).to.deep.equal([]);
    });

    it("hands the error of a failed call to the failure handler as it was thrown", async function () {
        const error = new GrammyError(
            "Call to 'sendMessage' failed! (400: Bad Request: chat not found)",
            { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            "sendMessage",
            { chat_id: CHAT_ID, text: "text" },
        );
        sender.error = error;
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await processor.process(message, signal);

        expect(failureHandler.calls).to.have.lengthOf(1);
        expect(failureHandler.calls[0]?.message).to.equal(message);
        expect(failureHandler.calls[0]?.error).to.equal(error);
        expect(store.done).to.deep.equal([]);
    });

    it("hands a payload the codec cannot read to the failure handler without a call", async function () {
        const message = pulledRow("sendDocument", { chat_id: CHAT_ID, document: { $pathFile: { path: "relative.ttf" } } });

        await processor.process(message, signal);

        expect(sender.calls).to.deep.equal([]);
        expect(failureHandler.calls).to.have.lengthOf(1);
        expect(failureHandler.calls[0]?.error).to.be.instanceOf(InvalidFileMarker);
        expect(store.done).to.deep.equal([]);
    });

    // grammY throws an aborted call as an HttpError, which the failure handler would retry or block on.
    it("releases a message whose call was aborted instead of handing it to the failure handler", async function () {
        const abortController = new AbortController();
        abortController.abort();
        sender.error = new HttpError("Network request for 'sendMessage' failed!", new Error("The operation was aborted."));
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await processor.process(message, abortController.signal);

        expect(leaseReleaser.released).to.deep.equal([message]);
        expect(failureHandler.calls).to.deep.equal([]);
        expect(store.done).to.deep.equal([]);
    });

    // Telegram refused the call in the same turn as the abort: its answer decides the outcome.
    it("hands an answer of Telegram to the failure handler although the call was aborted", async function () {
        const abortController = new AbortController();
        abortController.abort();
        const error = new GrammyError(
            "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
            { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
            "sendMessage",
            { chat_id: CHAT_ID, text: "text" },
        );
        sender.error = error;
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await processor.process(message, abortController.signal);

        expect(failureHandler.calls).to.deep.equal([{ message, error }]);
        expect(leaseReleaser.released).to.deep.equal([]);
    });

    // The abort came too late to stop the call: Telegram answered, and the message is sent.
    it("marks the message done when its call answers although it was aborted", async function () {
        const abortController = new AbortController();
        abortController.abort();
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await processor.process(message, abortController.signal);

        expect(store.done).to.deep.equal([{ lease: message, response: RESPONSE }]);
        expect(leaseReleaser.released).to.deep.equal([]);
    });

    it("keeps the files of a message whose call was aborted", async function () {
        const documentPath = await createFile("font.ttf");
        const abortController = new AbortController();
        abortController.abort();
        sender.error = new HttpError("Network request for 'sendDocument' failed!", new Error("The operation was aborted."));

        await processor.process(pulled("sendDocument", { chat_id: CHAT_ID, document: new PathFile(documentPath) }), abortController.signal);

        expect(await exists(documentPath)).to.equal(true);
    });

    it("removes every file of a done message, nested ones included", async function () {
        const documentPath = await createFile("font.ttf");
        const thumbnailPath = await createFile("thumbnail.jpg");

        await processor.process(mediaGroupOf(documentPath, thumbnailPath), signal);

        expect(await exists(documentPath)).to.equal(false);
        expect(await exists(thumbnailPath)).to.equal(false);
        expect(logger.warnings).to.deep.equal([]);
    });

    it("keeps the files of a message whose call failed", async function () {
        const documentPath = await createFile("font.ttf");
        const thumbnailPath = await createFile("thumbnail.jpg");
        sender.error = new Error("ECONNRESET");

        await processor.process(mediaGroupOf(documentPath, thumbnailPath), signal);

        expect(await exists(documentPath)).to.equal(true);
        expect(await exists(thumbnailPath)).to.equal(true);
    });

    // The recovery of an expired lease gave the message to another pull, which sends the files again.
    it("keeps the files when marking the message done changed nothing", async function () {
        const documentPath = await createFile("font.ttf");
        store.isDone = false;

        await processor.process(pulled("sendDocument", { chat_id: CHAT_ID, document: new PathFile(documentPath) }), signal);

        expect(await exists(documentPath)).to.equal(true);
    });

    // fs.rm() without recursive refuses a directory, which is what makes the removal fail here.
    it("logs a file it cannot remove and removes the next one", async function () {
        const unremovablePath = path.join(directory, "unremovable");
        await fs.mkdir(unremovablePath);
        const thumbnailPath = await createFile("thumbnail.jpg");
        const message = mediaGroupOf(unremovablePath, thumbnailPath);

        await processor.process(message, signal);

        expect(await exists(thumbnailPath)).to.equal(false);
        expect(logger.warnings).to.have.lengthOf(1);
        expect(logger.warnings[0]?.message).to.equal("The file of a sent outbox message was not removed.");
        expect(logger.warnings[0]?.payload).to.include({ messageId: message.id, path: unremovablePath });
        expect(logger.warnings[0]?.payload?.["cause"]).to.be.instanceOf(RemoveFailed);
    });

    async function createFile(name: string): Promise<string> {
        const filePath = path.join(directory, name);
        await fs.writeFile(filePath, "content");

        return filePath;
    }

    // A document with a thumbnail inside the media array: the files sit two levels deep.
    function mediaGroupOf(documentPath: string, thumbnailPath: string): PulledOutboxMessage {
        return pulled("sendMediaGroup", {
            chat_id: CHAT_ID,
            media: [{ type: "document", media: new PathFile(documentPath), thumbnail: new PathFile(thumbnailPath) }],
        });
    }
});

async function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
        () => true,
        () => false,
    );
}

// A pulled message whose payload the codec wrote from the call.
function pulled(method: string, payload: object): PulledOutboxMessage {
    return pulledRow(method, serialize(method, payload) as OutboxPayload);
}

// A pulled message with the payload as the row holds it.
function pulledRow(method: string, payload: OutboxPayload): PulledOutboxMessage {
    return {
        id: 7,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        startedAt: "2026-09-30T10:01:00.000000+00:00",
        worker: { host: "node-1", pid: 101, workerId: "worker-1" },
        chatId: CHAT_ID,
        method,
        payload,
        priority: 0,
        earlierAttempts: 0,
    };
}
