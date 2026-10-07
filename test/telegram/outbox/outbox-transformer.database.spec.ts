import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "chai";
import { Api, GrammyError } from "grammy";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { Database } from "app/platform/database/database";
import { RequestContext } from "app/platform/request-context/request-context";
import { FileHelper } from "app/shared/fs/file-helper";
import { MS_PER_SECOND } from "app/shared/time";
import { sleep } from "app/shared/utils";
import { isGroupChat } from "app/telegram/telegram-chat";
import { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import { PathFile } from "app/telegram/path-file/path-file";
import { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxFinishedMessageReader } from "app/telegram/outbox/outbox-finished-message-reader";
import { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import { OutboxRunner } from "app/telegram/outbox/outbox-runner";
import { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { OutboxLeaseRecovery } from "app/telegram/outbox/lease/outbox-lease-recovery";
import { OutboxLeaseReleaser } from "app/telegram/outbox/lease/outbox-lease-releaser";
import { OutboxLeaseRetrier } from "app/telegram/outbox/lease/outbox-lease-retrier";
import { OutboxMaintenance } from "app/telegram/outbox/maintenance/outbox-maintenance";
import { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import type { OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { FinishedOutboxMessage, OutboxCleanupSettings } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxTransformer } from "app/telegram/outbox/transformer/outbox-transformer";
import { testDatabaseSettings } from "test/database.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { waitUntil } from "test/shared/utils.helper";

const SPEC_TIMEOUT_MS = 30_000;
const FIRST_NODE_TOKEN = "first-node-token";
const SECOND_NODE_TOKEN = "second-node-token";
const PRIVATE_CHAT_IDS = [5_000_000_001, 5_000_000_002, 5_000_000_003, 5_000_000_004];
const GROUP_CHAT_ID = -1_005_000_000_001;
const HOUR_MS = 60 * 60 * MS_PER_SECOND;
// A cooldown of a nanosecond, below the microsecond of a timestamp, and a common limit no pull
// reaches: the specs of the other behaviour do not wait for the limits.
const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };
const LONG_LEASE_DURATION_MS = 60_000;
const SHORT_LEASE_DURATION_MS = 1_000;
// Longer than the lease of SHORT_LEASE_DURATION_MS: a call left unanswered outlives the lease, as
// the call of a node that died does.
const API_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 200;
const RESULT_TIMEOUT_MS = 10_000;
const RESULT_POLL_INTERVAL_MS = 50;
// Longer than the spec runs: a wait settles by the notification of its message alone.
const NO_RESULT_POLL_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 5;
// With the random of zero the first retry waits half of the first step.
const RETRY_DELAY = { firstDelayMs: 100, maxDelayMs: 1_000, multiplier: 2 };
const LEASE_RECOVERY_INTERVAL_MS = 50;
const CLEANUP: OutboxCleanupSettings = { doneRetentionMs: HOUR_MS, skippedRetentionMs: HOUR_MS, batchSize: 10 };
// The limits space the pulls by the clock of the database, while the fake Bot API stamps a call
// when it arrives, a send later, and the time from the pull to the arrival differs from call to
// call. A gap between two arrivals may come short of the limit by that difference.
const ARRIVAL_JITTER_MS = 100;
const RETRY_AFTER_SECONDS = 1;
// The longest a call waits for its answer in the spec of the order: long enough for the calls of
// several chats to be in flight at once.
const MAX_CALL_MS = 5;

// A call as the fake Bot API received it.
type BotApiCall = {
    // The node that made the call: each calls with a token of its own.
    token: string;
    method: string;
    chatId: number;
    text: string | undefined;
    // The content of the file sendDocument uploaded.
    document: string | undefined;
    receivedAtMs: number;
};

// The HTTP status and the body the fake Bot API answers a call with.
type BotApiAnswer = { status: number; body: object };

// What the fake Bot API answers a call with: callIndex is its place among the calls received, from 0.
type BotApiAnswerScript = (call: BotApiCall, callIndex: number) => BotApiAnswer | Promise<BotApiAnswer>;

// The answer of a call that never ends while the spec runs, as the call of a node that died.
const NEVER_ANSWERED = new Promise<BotApiAnswer>(() => undefined);

// A local HTTP server that takes the Bot API calls grammY sends to the apiRoot it is given:
// `<apiRoot>/bot<token>/<method>`, a JSON body, or multipart/form-data for a call with a file.
class FakeBotApi {
    public readonly calls: BotApiCall[] = [];
    private answer: BotApiAnswerScript = (call, callIndex) => sentMessage(call, callIndex);
    private readonly server: Server = createServer((request, response) => void this.handle(request, response));

    // Resolves with the apiRoot of the server.
    public async start(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        const { port } = this.server.address() as AddressInfo;

        return `http://127.0.0.1:${port}`;
    }

    // The calls never answered are cut off with their connections.
    public async close(): Promise<void> {
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    // Every call is answered with the Message it sends until a spec gives a script of its own.
    public answerWith(script: BotApiAnswerScript): void {
        this.answer = script;
    }

    public callsOf(chatId: number): BotApiCall[] {
        return this.calls.filter((call) => call.chatId === chatId);
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const receivedAtMs = Date.now();
        const [, token = "", method = ""] = /^\/bot([^/]+)\/([^/]+)$/.exec(request.url ?? "") ?? [];
        const fields = readFields(request.headers["content-type"] ?? "", await readBody(request));
        const call: BotApiCall = {
            token: token,
            method: method,
            chatId: Number(fields["chat_id"]),
            text: typeof fields["text"] === "string" ? fields["text"] : undefined,
            document: readDocument(fields),
            receivedAtMs: receivedAtMs,
        };
        const callIndex = this.calls.push(call) - 1;
        const answer = await this.answer(call, callIndex);

        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
    }
}

// Points the Api of the sender at the fake Bot API instead of Telegram.
class FakeBotApiFactory extends TelegramApiFactory {
    public constructor(private readonly token: string, private readonly apiRoot: string) {
        super(token);
    }

    public override create(timeoutSeconds: number): Api {
        return new Api(this.token, { apiRoot: this.apiRoot, timeoutSeconds: timeoutSeconds });
    }
}

// A reader whose listening never starts, as on a node whose LISTEN connection is down: the waits
// settle by the poll alone.
class DeafFinishedMessageReader extends OutboxFinishedMessageReader {
    public override async listen(): Promise<void> {
        // Neither the notifications nor the start of the listening reach the waiter.
    }
}

// Tells when the waiter has first read the table. Nothing reads it before the poll that follows the
// start of the listening, so by then the listening is up, and a message finished afterwards reaches
// a waiter that polls less often than the spec runs by its notification alone.
class ObservedFinishedMessageReader extends OutboxFinishedMessageReader {
    private readonly firstFind = Promise.withResolvers<void>();

    public get hasRead(): Promise<void> {
        return this.firstFind.promise;
    }

    public override async find(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        const messages = await super.find(messageIds);
        this.firstFind.resolve();

        return messages;
    }
}

type NodeSettings = {
    token: string;
    limits: TelegramLimits;
    leaseDurationMs: number;
    concurrency: number;
    resultWaiter: OutboxResultWaiterSettings;
    // The reader of the waiter; OutboxFinishedMessageReader on the database of the node if not given.
    reader?: OutboxFinishedMessageReader;
};

const FIRST_NODE: NodeSettings = {
    token: FIRST_NODE_TOKEN,
    limits: NO_LIMITS,
    leaseDurationMs: LONG_LEASE_DURATION_MS,
    concurrency: 4,
    resultWaiter: { timeoutMs: RESULT_TIMEOUT_MS, pollIntervalMs: RESULT_POLL_INTERVAL_MS },
};
const SECOND_NODE: NodeSettings = { ...FIRST_NODE, token: SECOND_NODE_TOKEN };

// The outbox of one node as the container puts it together, with a bot Api whose calls go through
// the transformer of the outbox.
type OutboxNode = {
    api: Api;
    runner: OutboxRunner;
    maintenance: OutboxMaintenance;
    waiter: OutboxResultWaiter;
    logger: RecordingLogger;
};

describe("OutboxTransformer on the database with a fake Bot API", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    // A client per node.
    let firstDatabase: Database;
    let secondDatabase: Database;
    let fakeBotApi: FakeBotApi;
    let apiRoot: string;
    let nodes: OutboxNode[];
    let workDir: string;

    before(async function () {
        const settings = await testDatabaseSettings();

        firstDatabase = new Database(settings, false);
        secondDatabase = new Database(settings, false);
    });

    beforeEach(async function () {
        await firstDatabase.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
        await firstDatabase.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
        `;
        fakeBotApi = new FakeBotApi();
        apiRoot = await fakeBotApi.start();
        nodes = [];
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbox-transformer-"));
    });

    afterEach(async function () {
        await Promise.all(nodes.map((node) => node.runner.stop()));
        await Promise.all(nodes.map((node) => node.maintenance.stop()));
        for (const node of nodes) {
            node.waiter.stop();
        }
        await fakeBotApi.close();
        await fs.rm(workDir, { recursive: true, force: true });
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await firstDatabase?.close();
        await secondDatabase?.close();
    });

    function createNode(database: Database, settings: NodeSettings): OutboxNode {
        const logger = new RecordingLogger();
        const store = new OutboxStore(database, logger, settings.limits, settings.leaseDurationMs, CLEANUP);
        const leaseRetrier = new OutboxLeaseRetrier(store, new RetryDelay(RETRY_DELAY, () => 0), MAX_ATTEMPTS);
        const failureHandler = new OutboxFailureHandler(
            store,
            new TelegramBotApiFailureClassifier(),
            leaseRetrier,
            new OutboxErrorSerializer(settings.token),
            logger,
        );
        const processor = new OutboxMessageProcessor(
            new OutboxSender(new FakeBotApiFactory(settings.token, apiRoot), API_TIMEOUT_MS),
            store,
            failureHandler,
            new OutboxLeaseReleaser(store),
            logger,
        );
        // The shortest sleep cap: a pull that finds nothing ready waits 100 ms, not up to a second.
        const source = new OutboxMessageSource(store, logger, () => 0);
        const worker = { host: settings.token, pid: 1, workerId: `${settings.token}-runner` };
        const runner = new OutboxRunner(source, processor, logger, settings.concurrency, STOP_TIMEOUT_MS, worker);
        const maintenance = new OutboxMaintenance(store, new OutboxLeaseRecovery(store, leaseRetrier), logger, {
            leaseRecoveryIntervalMs: LEASE_RECOVERY_INTERVAL_MS,
            cleanupIntervalMs: HOUR_MS,
            statusLogIntervalMs: HOUR_MS,
            blockedLogIntervalMs: HOUR_MS,
        });
        const reader = settings.reader ?? new OutboxFinishedMessageReader(database);
        const waiter = new OutboxResultWaiter(reader, logger, new RequestContext(), settings.resultWaiter);
        const api = new Api(settings.token, { apiRoot: apiRoot });
        api.config.use(new OutboxTransformer(store, waiter).transform);

        const node = { api: api, runner: runner, maintenance: maintenance, waiter: waiter, logger: logger };
        nodes.push(node);

        return node;
    }

    async function writeFile(name: string, content: string): Promise<string> {
        const filePath = path.join(workDir, name);
        await fs.writeFile(filePath, content);

        return filePath;
    }

    async function chatState(chatId: number): Promise<string | undefined> {
        const [row] = await firstDatabase.sql<{ state: string }[]>`
            SELECT state
            FROM telegram_outbox_chats
            WHERE chat_id = ${chatId}
        `;

        return row?.state;
    }

    // The status of every message of the chat and the name of the error of each of its attempts,
    // in the order of the messages.
    async function chatMessages(chatId: number): Promise<{ status: string; errors: (string | null)[] }[]> {
        return firstDatabase.sql<{ status: string; errors: (string | null)[] }[]>`
            SELECT status,
                   (SELECT coalesce(jsonb_agg(attempt -> 'error' ->> 'name'), '[]'::jsonb)
                    FROM jsonb_array_elements(attempts) AS attempt) AS errors
            FROM telegram_outbox
            WHERE chat_id = ${chatId}
            ORDER BY id
        `;
    }

    describe("the result of a call", function () {
        it("comes back by the notification of its outcome", async function () {
            const reader = new ObservedFinishedMessageReader(firstDatabase);
            const node = createNode(firstDatabase, {
                ...FIRST_NODE,
                reader: reader,
                resultWaiter: { timeoutMs: RESULT_TIMEOUT_MS, pollIntervalMs: NO_RESULT_POLL_INTERVAL_MS },
            });
            fakeBotApi.answerWith(async (call, callIndex) => {
                await reader.hasRead;

                return sentMessage(call, callIndex);
            });
            node.runner.start();

            const sent = await node.api.sendMessage(PRIVATE_CHAT_IDS[0]!, "hello");

            expect(sent).to.deep.include({ message_id: 1, text: "hello" });
            expect(sent.chat.id).to.equal(PRIVATE_CHAT_IDS[0]);
            expect(fakeBotApi.calls.map((call) => [call.token, call.method, call.chatId])).to.deep.equal([
                [FIRST_NODE_TOKEN, "sendMessage", PRIVATE_CHAT_IDS[0]],
            ]);
            expect([...node.logger.criticals, ...node.logger.errors, ...node.logger.warnings]).to.deep.equal([]);
        });

        it("comes back by the poll when no notification reaches the waiter", async function () {
            const node = createNode(firstDatabase, { ...FIRST_NODE, reader: new DeafFinishedMessageReader(firstDatabase) });
            node.runner.start();

            const sent = await node.api.sendMessage(PRIVATE_CHAT_IDS[0]!, "hello");

            expect(sent).to.deep.include({ message_id: 1, text: "hello" });
        });

        it("rejects the call with the answer of Telegram to a message that failed", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            fakeBotApi.answerWith(() => failure(403, "Forbidden: bot was blocked by the user"));
            node.runner.start();

            const error = await caught(node.api.sendMessage(PRIVATE_CHAT_IDS[0]!, "hello"));

            expect(error).to.be.instanceOf(GrammyError);
            expect(error).to.deep.include({ error_code: 403, description: "Forbidden: bot was blocked by the user" });
        });
    });

    describe("the file of a PathFile", function () {
        it("is uploaded and removed once its message is done", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            const fontPath = await writeFile("font.ttf", "font bytes");
            node.runner.start();

            const sent = await node.api.sendDocument(PRIVATE_CHAT_IDS[0]!, new PathFile(fontPath));

            expect(sent.document).to.deep.include({ file_name: "font.ttf" });
            expect(fakeBotApi.calls.map((call) => [call.method, call.document])).to.deep.equal([["sendDocument", "font bytes"]]);
            // The removal follows the completion, and the notification of the completion may settle
            // the call first.
            await waitUntil(async () => !(await FileHelper.isExist(fontPath)), "the file of the sent message was expected to be removed");
        });

        it("is kept when its message fails", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            const fontPath = await writeFile("font.ttf", "font bytes");
            fakeBotApi.answerWith(() => failure(403, "Forbidden: bot was blocked by the user"));
            node.runner.start();

            await caught(node.api.sendDocument(PRIVATE_CHAT_IDS[0]!, new PathFile(fontPath)));

            expect(await FileHelper.isExist(fontPath)).to.equal(true);
        });
    });

    it("sends the messages of each chat in the order of their calls", async function () {
        const node = createNode(firstDatabase, FIRST_NODE);
        const chatIds = PRIVATE_CHAT_IDS.slice(0, 2);
        const texts = ["0", "1", "2", "3", "4"];
        fakeBotApi.answerWith(async (call, callIndex) => {
            await sleep(Math.random() * MAX_CALL_MS);

            return sentMessage(call, callIndex);
        });
        node.runner.start();

        const calls = chatIds.flatMap((chatId) => texts.map((text) => ({ chatId: chatId, text: `${chatId}:${text}` })));
        const sent = await Promise.all(calls.map((call) => node.api.sendMessage(call.chatId, call.text)));

        // Every caller gets the result of its own message.
        expect(sent.map((message) => message.text)).to.deep.equal(calls.map((call) => call.text));
        for (const chatId of chatIds) {
            // The calls go out concurrently, so their messages are pushed in an order of their own:
            // the order of the outbox is the order of the ids.
            const pushed = await firstDatabase.sql<{ text: string }[]>`
                SELECT payload ->> 'text' AS text
                FROM telegram_outbox
                WHERE chat_id = ${chatId}
                ORDER BY id
            `;

            expect(
                fakeBotApi.callsOf(chatId).map((call) => call.text),
                `the calls of chat ${chatId}`,
            ).to.deep.equal(pushed.map((row) => row.text));
        }
    });

    describe("the limits", function () {
        it("let no more calls of two nodes through per interval than the common limit", async function () {
            const common = { number: 3, interval: 600 };
            const limits = { ...NO_LIMITS, common: common };
            const firstNode = createNode(firstDatabase, { ...FIRST_NODE, limits: limits, concurrency: 2 });
            const secondNode = createNode(secondDatabase, { ...SECOND_NODE, limits: limits, concurrency: 2 });
            firstNode.runner.start();
            secondNode.runner.start();

            await Promise.all(PRIVATE_CHAT_IDS.flatMap((chatId) => ["0", "1"].map((text) => firstNode.api.sendMessage(chatId, text))));

            const arrivalsMs = fakeBotApi.calls.map((call) => call.receivedAtMs);
            expect(arrivalsMs).to.have.lengthOf(PRIVATE_CHAT_IDS.length * 2);
            // Any number + 1 calls in a row span at least the interval.
            for (let index = common.number; index < arrivalsMs.length; index += 1) {
                const spanMs = arrivalsMs[index]! - arrivalsMs[index - common.number]!;

                expect(spanMs, `the span of calls ${index - common.number}..${index}`).to.be.at.least(common.interval - ARRIVAL_JITTER_MS);
            }
        });

        it("space the calls of a chat by the limit of its kind", async function () {
            const limits = { common: NO_LIMIT, private: { number: 1, interval: 300 }, group: { number: 1, interval: 500 } };
            const node = createNode(firstDatabase, { ...FIRST_NODE, limits: limits });
            const privateChatId = PRIVATE_CHAT_IDS[0]!;
            node.runner.start();

            await Promise.all(
                [privateChatId, GROUP_CHAT_ID].flatMap((chatId) => ["0", "1", "2"].map((text) => node.api.sendMessage(chatId, text))),
            );

            expect(gapsMs(fakeBotApi.callsOf(privateChatId))).to.have.lengthOf(2);
            for (const gapMs of gapsMs(fakeBotApi.callsOf(privateChatId))) {
                expect(gapMs, "a gap between the calls of the private chat").to.be.at.least(limits.private.interval - ARRIVAL_JITTER_MS);
            }
            expect(gapsMs(fakeBotApi.callsOf(GROUP_CHAT_ID))).to.have.lengthOf(2);
            for (const gapMs of gapsMs(fakeBotApi.callsOf(GROUP_CHAT_ID))) {
                expect(gapMs, "a gap between the calls of the group").to.be.at.least(limits.group.interval - ARRIVAL_JITTER_MS);
            }
        });
    });

    it("pauses the sending of every node for the retry_after of a 429", async function () {
        // A cooldown far longer than a 429 takes to come back and pause the outbox: no node pulls
        // another message between the call that got the 429 and the pause.
        const limits = { ...NO_LIMITS, common: { number: 5, interval: 1_000 } };
        const firstNode = createNode(firstDatabase, { ...FIRST_NODE, limits: limits });
        const secondNode = createNode(secondDatabase, { ...SECOND_NODE, limits: limits });
        fakeBotApi.answerWith((call, callIndex) => {
            if (callIndex === 0) {
                return failure(429, `Too Many Requests: retry after ${RETRY_AFTER_SECONDS}`, { retry_after: RETRY_AFTER_SECONDS });
            }

            return sentMessage(call, callIndex);
        });
        firstNode.runner.start();
        secondNode.runner.start();

        const calls = PRIVATE_CHAT_IDS.slice(0, 3).flatMap((chatId) => ["0", "1"].map((text) => ({ chatId: chatId, text: text })));
        const sent = await Promise.all(calls.map((call) => firstNode.api.sendMessage(call.chatId, call.text)));

        // The message that got the 429 is sent again after the pause, and its caller gets that answer.
        expect(sent.map((message) => [message.chat.id, message.text])).to.deep.equal(calls.map((call) => [call.chatId, call.text]));
        const [floodedCall, nextCall] = fakeBotApi.calls;
        expect(fakeBotApi.calls).to.have.lengthOf(calls.length + 1);
        expect(nextCall!.receivedAtMs - floodedCall!.receivedAtMs).to.be.at.least(RETRY_AFTER_SECONDS * MS_PER_SECOND - ARRIVAL_JITTER_MS);
    });

    describe("a failed call", function () {
        it("is retried after a transient failure and resolves with the later answer", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            const chatId = PRIVATE_CHAT_IDS[0]!;
            fakeBotApi.answerWith((call, callIndex) => (callIndex === 0 ? failure(502, "Bad Gateway") : sentMessage(call, callIndex)));
            node.runner.start();

            const sent = await node.api.sendMessage(chatId, "hello");

            expect(sent).to.deep.include({ message_id: 2, text: "hello" });
            expect(fakeBotApi.callsOf(chatId).map((call) => call.text)).to.deep.equal(["hello", "hello"]);
            expect(await chatMessages(chatId)).to.deep.equal([{ status: OutboxStatus.Done, errors: ["GrammyError", null] }]);
        });

        it("fails its message without a retry when the chat cannot get it, and the chat goes on", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            const chatId = PRIVATE_CHAT_IDS[0]!;
            fakeBotApi.answerWith((call, callIndex) =>
                call.text === "refused" ? failure(403, "Forbidden: bot was blocked by the user") : sentMessage(call, callIndex),
            );
            node.runner.start();

            const refused = await caught(node.api.sendMessage(chatId, "refused"));
            const sent = await node.api.sendMessage(chatId, "next");

            expect(refused).to.be.instanceOf(GrammyError);
            expect(sent).to.deep.include({ text: "next" });
            expect(fakeBotApi.callsOf(chatId).map((call) => call.text)).to.deep.equal(["refused", "next"]);
            expect(await chatMessages(chatId)).to.deep.equal([
                { status: OutboxStatus.Failed, errors: ["GrammyError"] },
                { status: OutboxStatus.Done, errors: [null] },
            ]);
        });

        it("fails its message and blocks its chat on an answer the classifier calls unexpected", async function () {
            const node = createNode(firstDatabase, FIRST_NODE);
            const [blockedChatId, otherChatId] = PRIVATE_CHAT_IDS as [number, number];
            fakeBotApi.answerWith((call, callIndex) =>
                call.chatId === blockedChatId ? failure(400, "Bad Request: message text is empty") : sentMessage(call, callIndex),
            );
            node.runner.start();

            const failed = await caught(node.api.sendMessage(blockedChatId, "failing"));
            // The next message of the blocked chat stays behind the failed one, so its caller waits
            // until the waiter stops.
            const waitingCall = node.api.sendMessage(blockedChatId, "waiting").catch((error: unknown) => error);
            await waitUntil(async () => (await chatMessages(blockedChatId)).length === 2, "the next message was expected to be pushed");
            // A message of another chat pushed after it: once that is sent, the loop has had its
            // chance at the blocked chat.
            await node.api.sendMessage(otherChatId, "other");

            expect(failed).to.be.instanceOf(GrammyError);
            expect(failed).to.deep.include({ error_code: 400 });
            expect(fakeBotApi.callsOf(blockedChatId)).to.have.lengthOf(1);
            expect(await chatState(blockedChatId)).to.equal(OutboxChatState.Blocked);
            expect(await chatMessages(blockedChatId)).to.deep.equal([
                { status: OutboxStatus.Failed, errors: ["GrammyError"] },
                { status: OutboxStatus.Pending, errors: [] },
            ]);
            node.waiter.stop();
            await waitingCall;
        });
    });

    describe("a message whose node does not finish its call", function () {
        it("goes to another node once its lease passes when the node died mid-send", async function () {
            const firstNode = createNode(firstDatabase, { ...FIRST_NODE, leaseDurationMs: SHORT_LEASE_DURATION_MS, concurrency: 1 });
            const secondNode = createNode(secondDatabase, { ...SECOND_NODE, leaseDurationMs: SHORT_LEASE_DURATION_MS });
            const chatId = PRIVATE_CHAT_IDS[0]!;
            // The first node gets no answer and its call outlives the lease: to the outbox it is a
            // node that died after the pull. Its only slot stays busy, so it pulls nothing more.
            fakeBotApi.answerWith((call, callIndex) => (callIndex === 0 ? NEVER_ANSWERED : sentMessage(call, callIndex)));
            firstNode.runner.start();

            const sending = firstNode.api.sendMessage(chatId, "hello");
            await waitUntil(() => fakeBotApi.calls.length === 1, "the first node was expected to call the Bot API");
            secondNode.runner.start();
            secondNode.maintenance.start();
            const sent = await sending;

            expect(sent).to.deep.include({ message_id: 2, text: "hello" });
            const [deadCall, recoveredCall] = fakeBotApi.calls;
            expect([deadCall!.token, recoveredCall!.token]).to.deep.equal([FIRST_NODE_TOKEN, SECOND_NODE_TOKEN]);
            expect(recoveredCall!.receivedAtMs - deadCall!.receivedAtMs).to.be.at.least(SHORT_LEASE_DURATION_MS - ARRIVAL_JITTER_MS);
            expect(await chatMessages(chatId)).to.deep.equal([{ status: OutboxStatus.Done, errors: ["OutboxLeaseExpired", null] }]);
        });

        it("goes to another node at once when the node is stopped mid-send", async function () {
            const firstNode = createNode(firstDatabase, { ...FIRST_NODE, concurrency: 1 });
            const secondNode = createNode(secondDatabase, SECOND_NODE);
            const chatId = PRIVATE_CHAT_IDS[0]!;
            fakeBotApi.answerWith((call, callIndex) => (callIndex === 0 ? NEVER_ANSWERED : sentMessage(call, callIndex)));
            firstNode.runner.start();

            const sending = firstNode.api.sendMessage(chatId, "hello");
            await waitUntil(() => fakeBotApi.calls.length === 1, "the first node was expected to call the Bot API");
            secondNode.runner.start();
            // Aborts the unanswered call at the stop deadline and releases its message.
            await firstNode.runner.stop();
            const sent = await sending;

            expect(sent).to.deep.include({ message_id: 2, text: "hello" });
            const [stoppedCall, releasedCall] = fakeBotApi.calls;
            expect([stoppedCall!.token, releasedCall!.token]).to.deep.equal([FIRST_NODE_TOKEN, SECOND_NODE_TOKEN]);
            expect(releasedCall!.receivedAtMs - stoppedCall!.receivedAtMs).to.be.below(LONG_LEASE_DURATION_MS);
            expect(await chatMessages(chatId)).to.deep.equal([{ status: OutboxStatus.Done, errors: ["OutboxNodeStopped", null] }]);
        });
    });
});

// The answer of Telegram to a sent message: the Message, with the text or the document of the call.
function sentMessage(call: BotApiCall, callIndex: number): BotApiAnswer {
    const chat = isGroupChat(call.chatId)
        ? { id: call.chatId, type: "group", title: "group" }
        : { id: call.chatId, type: "private", first_name: "user" };
    const message: Record<string, unknown> = { message_id: callIndex + 1, date: 0, chat: chat };

    if (call.text !== undefined) {
        message["text"] = call.text;
    }

    if (call.document !== undefined) {
        message["document"] = { file_id: "file-id", file_unique_id: "file-unique-id", file_name: "font.ttf" };
    }

    return { status: 200, body: { ok: true, result: message } };
}

// An answer of Telegram with ok: false; the Bot API repeats error_code as the HTTP status.
function failure(errorCode: number, description: string, parameters: object = {}): BotApiAnswer {
    return { status: errorCode, body: { ok: false, error_code: errorCode, description: description, parameters: parameters } };
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString();
}

// The fields of a call: a JSON body, or the parts of multipart/form-data, which grammY sends for a
// call with a file. It writes each field as a part named by the field, and the file as a part named
// by an id the field of the file refers to as attach://<id> (payloadToMultipartItr() in its
// core/payload.js).
function readFields(contentType: string, body: string): Record<string, unknown> {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];

    if (boundary === undefined) {
        return JSON.parse(body) as Record<string, unknown>;
    }

    const fields: Record<string, unknown> = {};

    for (const part of body.split(`--${boundary}`)) {
        const headersEnd = part.indexOf("\r\n\r\n");
        const name = /name="([^"]+)"/.exec(part.slice(0, headersEnd))?.[1];

        if (headersEnd === -1 || name === undefined) {
            continue;
        }

        fields[name] = part.slice(headersEnd + "\r\n\r\n".length).replace(/\r\n$/, "");
    }

    return fields;
}

function readDocument(fields: Record<string, unknown>): string | undefined {
    const document = fields["document"];

    if (typeof document !== "string" || !document.startsWith("attach://")) {
        return undefined;
    }

    return String(fields[document.slice("attach://".length)]);
}

// The gaps between the arrivals of the calls, in their order.
function gapsMs(calls: BotApiCall[]): number[] {
    const gaps: number[] = [];

    for (let index = 1; index < calls.length; index += 1) {
        gaps.push(calls[index]!.receivedAtMs - calls[index - 1]!.receivedAtMs);
    }

    return gaps;
}

function caught(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => expect.fail("the call was expected to reject"),
        (error: unknown) => error,
    );
}
