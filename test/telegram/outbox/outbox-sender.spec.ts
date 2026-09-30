import fs from "fs/promises";
import os from "os";
import path from "path";
import { expect } from "chai";
import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { Logger } from "app/platform/logger/logger";
import { RemoveFailed } from "app/shared/fs/file-helper.errors";
import type { UnknownObject } from "app/shared/types";
import { PathFile } from "app/telegram/path-file/path-file";
import type { OutboxApiFactory } from "app/telegram/outbox/outbox-api-factory";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import { InvalidFileMarker } from "app/telegram/outbox/payload-codec/payload-codec.errors";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxJson, OutboxLease, OutboxPayload, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

const CHAT_ID = 5_000_000_001;
const RESPONSE: OutboxJson = { message_id: 42, chat: { id: CHAT_ID } };

type ApiCall = { method: string; args: unknown[] };

// Stands for Api.raw as the sender uses it: any method by name. It answers with the response, or
// throws the error when one is set.
class FakeApi {
    public readonly calls: ApiCall[] = [];
    public error: unknown = undefined;

    public readonly raw = new Proxy(
        {},
        {
            get: (_target, method: string) => {
                return async (...args: unknown[]): Promise<OutboxJson> => {
                    this.calls.push({ method, args });

                    if (this.error !== undefined) {
                        throw this.error;
                    }

                    return RESPONSE;
                };
            },
        },
    );
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

type LogRecord = { message: string; payload: UnknownObject | undefined };

class RecordingLogger implements Logger {
    public readonly warnings: LogRecord[] = [];

    public critical(): void {}

    public error(): void {}

    public warning(message: string, payload?: UnknownObject): void {
        this.warnings.push({ message, payload });
    }

    public info(): void {}

    public debug(): void {}
}

describe("OutboxSender", function () {
    let api: FakeApi;
    let store: RecordingStore;
    let failureHandler: RecordingFailureHandler;
    let logger: RecordingLogger;
    let sender: OutboxSender;
    let directory: string;

    beforeEach(async function () {
        api = new FakeApi();
        store = new RecordingStore();
        failureHandler = new RecordingFailureHandler();
        logger = new RecordingLogger();
        const apiFactory = { create: () => api as unknown as Api } as unknown as OutboxApiFactory;
        sender = new OutboxSender(store as unknown as OutboxStore, failureHandler as unknown as OutboxFailureHandler, apiFactory, logger);
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "outbox-sender-"));
    });

    afterEach(async function () {
        await fs.rm(directory, { recursive: true, force: true });
    });

    it("calls the method of the message with its payload alone, the files rebuilt", async function () {
        const documentPath = await createFile("font.ttf");

        await sender.send(pulled("sendDocument", { chat_id: CHAT_ID, document: new PathFile(documentPath, "font.ttf") }));

        expect(api.calls).to.have.lengthOf(1);
        const [{ method, args }] = api.calls as [ApiCall];
        expect(method).to.equal("sendDocument");
        expect(args).to.have.lengthOf(1);
        expect(args[0]).to.have.property("chat_id", CHAT_ID);
        expect(args[0])
            .to.have.property("document")
            .that.is.instanceOf(PathFile)
            .and.includes({ path: documentPath, filename: "font.ttf" });
    });

    it("marks the message done with the response of the call", async function () {
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await sender.send(message);

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
        api.error = error;
        const message = pulled("sendMessage", { chat_id: CHAT_ID, text: "text" });

        await sender.send(message);

        expect(failureHandler.calls).to.have.lengthOf(1);
        expect(failureHandler.calls[0]?.message).to.equal(message);
        expect(failureHandler.calls[0]?.error).to.equal(error);
        expect(store.done).to.deep.equal([]);
    });

    it("hands a payload the codec cannot read to the failure handler without a call", async function () {
        const message = pulledRow("sendDocument", { chat_id: CHAT_ID, document: { $pathFile: { path: "relative.ttf" } } });

        await sender.send(message);

        expect(api.calls).to.deep.equal([]);
        expect(failureHandler.calls).to.have.lengthOf(1);
        expect(failureHandler.calls[0]?.error).to.be.instanceOf(InvalidFileMarker);
        expect(store.done).to.deep.equal([]);
    });

    it("removes every file of a done message, nested ones included", async function () {
        const documentPath = await createFile("font.ttf");
        const thumbnailPath = await createFile("thumbnail.jpg");

        await sender.send(mediaGroupOf(documentPath, thumbnailPath));

        expect(await exists(documentPath)).to.equal(false);
        expect(await exists(thumbnailPath)).to.equal(false);
        expect(logger.warnings).to.deep.equal([]);
    });

    it("keeps the files of a message whose call failed", async function () {
        const documentPath = await createFile("font.ttf");
        const thumbnailPath = await createFile("thumbnail.jpg");
        api.error = new Error("ECONNRESET");

        await sender.send(mediaGroupOf(documentPath, thumbnailPath));

        expect(await exists(documentPath)).to.equal(true);
        expect(await exists(thumbnailPath)).to.equal(true);
    });

    // The recovery of an expired lease gave the message to another pull, which sends the files again.
    it("keeps the files when marking the message done changed nothing", async function () {
        const documentPath = await createFile("font.ttf");
        store.isDone = false;

        await sender.send(pulled("sendDocument", { chat_id: CHAT_ID, document: new PathFile(documentPath) }));

        expect(await exists(documentPath)).to.equal(true);
    });

    // fs.rm() without recursive refuses a directory, which is what makes the removal fail here.
    it("logs a file it cannot remove and removes the next one", async function () {
        const unremovablePath = path.join(directory, "unremovable");
        await fs.mkdir(unremovablePath);
        const thumbnailPath = await createFile("thumbnail.jpg");
        const message = mediaGroupOf(unremovablePath, thumbnailPath);

        await sender.send(message);

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
