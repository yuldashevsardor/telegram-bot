import "reflect-metadata";
import http from "http";
import { constants as httpStatus } from "node:http2";
import type { AddressInfo } from "net";
import path from "path";
import { expect } from "chai";
import { Api } from "grammy";
import type { RawApi, StorageAdapter, Transformer } from "grammy";
import type { ApiResponse, Document, Message, MessageEntity, Update, UserFromGetMe } from "@grammyjs/types";
import { Container } from "app/bootstrap/container/container";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { Database } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import { sleep } from "app/shared/utils";
import type { Bot } from "app/telegram/bot/bot";
import type { InboxRunner } from "app/telegram/inbox/inbox-runner";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxAttempt, InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import { InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";
import type { OutboxRunner } from "app/telegram/outbox/outbox-runner";
import type { SessionPayload } from "app/telegram/session/session.types";
import { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";
import { testDatabaseName } from "test/database.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { waitUntil } from "test/shared/utils.helper";
import { messageInput } from "test/telegram/inbox/inbox-store.helper";

const TOKEN = "123456789:secret";
const ME = { id: 123456789, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;
// A user per group, each in the private chat of the same id.
const FIRST_USER = 5_000_000_001;
const SECOND_USER = 5_000_000_002;
const MAX_ATTEMPTS = 3;
// What the spec sets in the config of the application; the rest is its defaults and the database of
// the run.
const CONFIG = {
    BOT_TOKEN: TOKEN,
    INBOX_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    // The retry delay of a millisecond: a retried update is claimed again at the next claim.
    OUTBOX_RETRY_FIRST_DELAY: "1",
    OUTBOX_RETRY_MAX_DELAY: "1",
    // A reply sent before its wait started is found by the poll of the waiter, not by a notification.
    OUTBOX_RESULT_POLL_INTERVAL: "50",
};
// Longer than the two replies of the parallel check take to come together, shorter than the wait
// for the done updates (WAIT_UNTIL_DEADLINE_MS): a handling one group after another fails with the
// order of the calls.
const HOLD_TIMEOUT_MS = 3_000;
const HOLD_POLL_INTERVAL_MS = 10;
const SPEC_TIMEOUT_MS = 30_000;

type BotApiCall = { method: string; payload: Record<string, unknown> };

// What a Bot API call of the bot resolved to.
type BotApiAnswer = { method: string; result: unknown };

// When a sendMessage came to the fake Bot API and when it was answered.
type SendEvent = { kind: "came" | "answered"; chatId: number };

type UpdateRow = { update_id: string; status: InboxStatus; attempts: InboxAttempt[] };

// A Bot API on a local port that answers as Telegram does: getMe with the bot, setMyCommands with
// true, sendMessage with the message it has sent, and a method it does not know with 404, in the HTTP
// status as in the body.
class FakeBotApi {
    public readonly calls: BotApiCall[] = [];
    // The messages sendMessage answered with, in the order of the answers.
    public readonly sentMessages: Message.TextMessage[] = [];
    public readonly sendEvents: SendEvent[] = [];

    private readonly heldChatIds = new Set<number>();
    private nextMessageId = 1;
    private readonly server = http.createServer((request, response) => {
        this.answer(request, response).catch((error: unknown) => response.destroy(error as Error));
    });

    // The API root to give grammY: it calls <root>/bot<token>/<method>.
    public async start(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        const { port } = this.server.address() as AddressInfo;

        return `http://127.0.0.1:${port}`;
    }

    public async stop(): Promise<void> {
        // grammY keeps its connections alive, and close() alone would wait for them.
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    // The sendMessage of each of the chats is answered only once a sendMessage of every one of them
    // has come, or after HOLD_TIMEOUT_MS.
    public holdSendsUntilAllCome(chatIds: number[]): void {
        for (const chatId of chatIds) {
            this.heldChatIds.add(chatId);
        }
    }

    public sendsTo(chatId: number): BotApiCall[] {
        return this.calls.filter((call) => call.method === "sendMessage" && call.payload["chat_id"] === chatId);
    }

    private async answer(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const method = path.basename(request.url ?? "");
        const payload = JSON.parse(await readBody(request)) as Record<string, unknown>;
        this.calls.push({ method: method, payload: payload });

        const answer = await this.resultOf(method, payload);
        response.statusCode = answer.ok ? httpStatus.HTTP_STATUS_OK : answer.error_code;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(answer));
    }

    private async resultOf(method: string, payload: Record<string, unknown>): Promise<ApiResponse<unknown>> {
        switch (method) {
            case "getMe":
                return { ok: true, result: ME };
            case "setMyCommands":
                return { ok: true, result: true };
            case "sendMessage":
                return { ok: true, result: await this.sendMessage(payload) };
            default:
                return { ok: false, error_code: httpStatus.HTTP_STATUS_NOT_FOUND, description: "Not Found: method not found" };
        }
    }

    private async sendMessage(payload: Record<string, unknown>): Promise<Message.TextMessage> {
        const chatId = Number(payload["chat_id"]);
        this.sendEvents.push({ kind: "came", chatId: chatId });

        if (this.heldChatIds.has(chatId)) {
            await this.waitForHeldChats();
        }

        const message: Message.TextMessage = {
            message_id: this.nextMessageId,
            date: 0,
            chat: { id: chatId, type: "private", first_name: "User" },
            text: String(payload["text"]),
        };
        this.nextMessageId += 1;
        this.sendEvents.push({ kind: "answered", chatId: chatId });
        this.sentMessages.push(message);

        return message;
    }

    private async waitForHeldChats(): Promise<void> {
        const deadline = Date.now() + HOLD_TIMEOUT_MS;

        while (!this.haveAllHeldChatsCome() && Date.now() < deadline) {
            await sleep(HOLD_POLL_INTERVAL_MS);
        }
    }

    private haveAllHeldChatsCome(): boolean {
        const cameChatIds = new Set(this.sendEvents.filter((event) => event.kind === "came").map((event) => event.chatId));

        return [...this.heldChatIds].every((chatId) => cameChatIds.has(chatId));
    }
}

// The Api the outbox sends with, pointed at the fake Bot API.
class FakeBotApiFactory extends TelegramApiFactory {
    public constructor(private readonly apiRoot: string) {
        super(TOKEN);
    }

    public override create(timeoutSeconds: number): Api {
        return new Api(TOKEN, { apiRoot: this.apiRoot, timeoutSeconds: timeoutSeconds });
    }
}

// A failed read with the code of a socket the peer reset: InboxFailureClassifier takes it for a lost
// database connection, a transient failure.
class ConnectionResetError extends Error {
    public readonly code = "ECONNRESET";

    public constructor() {
        super("read ECONNRESET");
    }
}

// The session storage of the application, whose reads of the given sessions fail first: the handler
// of an update fails as a restart of PostgreSQL would fail it.
class FailingSessionStorage implements StorageAdapter<SessionPayload> {
    private readonly failuresLeftByKey = new Map<string, number>();

    public constructor(private readonly storage: StorageAdapter<SessionPayload>) {}

    // The session of the user in their private chat.
    public failReads(userId: number, count: number): void {
        this.failuresLeftByKey.set(`${userId}:${userId}`, count);
    }

    public async read(key: string): Promise<SessionPayload | undefined> {
        const failuresLeft = this.failuresLeftByKey.get(key) ?? 0;

        if (failuresLeft > 0) {
            this.failuresLeftByKey.set(key, failuresLeft - 1);

            throw new ConnectionResetError();
        }

        return this.storage.read(key);
    }

    public async write(key: string, value: SessionPayload): Promise<void> {
        await this.storage.write(key, value);
    }

    public async delete(key: string): Promise<void> {
        await this.storage.delete(key);
    }
}

// The whole chain of the application but the webhook: an update pushed into telegram_inbox goes
// through InboxRunner into the bot of the application, and the replies of its handler go through the
// outbox to the fake Bot API (docs/architecture/inbox.md, "Testing").
describe("Inbox end to end on the database", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let fakeBotApi: FakeBotApi;
    let logger: RecordingLogger;
    let container: Container;
    let database: Database;
    let sessionStorage: FailingSessionStorage;
    let store: InboxStore;
    let inboxRunner: InboxRunner;
    let outboxRunner: OutboxRunner;
    // What the Bot API calls of the bot resolved to, ctx.reply() of the handlers included.
    let answers: BotApiAnswer[];
    let welcomeReply: string;
    let notTextReply: string;
    // What afterEach undoes, in the reverse order: only what this beforeEach got to start, so a failed
    // one neither leaves the new objects open nor stops those of the previous test again.
    let cleanups: (() => Promise<void> | void)[] = [];

    beforeEach(async function () {
        fakeBotApi = new FakeBotApi();
        const apiRoot = await fakeBotApi.start();
        cleanups.push(() => fakeBotApi.stop());
        logger = new RecordingLogger();
        // Only the variables of the database come from the environment, as in testDatabaseSettings():
        // another setting of a developer's .env, a concurrency of 1, would change what the spec checks.
        const env = await new ConfigEnvStorage().load();
        const databaseEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("DATABASE_")));
        await fillApplicationContext({ ...databaseEnv, ...CONFIG, DATABASE_NAME: testDatabaseName() }, logger);
        cleanups.push(resetApplicationContext);

        container = new Container();
        await container.setup();
        cleanups.push(() => container.close());
        database = container.get<Database>(Tokens.Platform.Database);
        await clearTables();

        sessionStorage = new FailingSessionStorage(container.get<StorageAdapter<SessionPayload>>(Tokens.Bot.Session.Storage));
        container.rebind(Tokens.Bot.Session.Storage).toConstantValue(sessionStorage);
        container.rebind(Tokens.Bot.ApiFactory).toConstantValue(new FakeBotApiFactory(apiRoot));

        const bot = container.get<Bot>(Tokens.Bot.Bot);
        // Before setup(): the transformer of the outbox goes over it.
        bot.grammy.api.config.use(sendToFakeBotApi(apiRoot));
        await bot.setup();
        answers = [];
        bot.grammy.api.config.use(recordAnswers(answers));
        fakeBotApi.calls.length = 0;
        ({ welcomeReply, notTextReply } = await expectedReplies());

        store = container.get<InboxStore>(Tokens.Bot.Inbox.Store);
        outboxRunner = container.get<OutboxRunner>(Tokens.Bot.Outbox.Runner);
        inboxRunner = container.get<InboxRunner>(Tokens.Bot.Inbox.Runner);
        // As Application starts them: the outbox first, the handlers await its results.
        outboxRunner.start();
        cleanups.push(() => outboxRunner.stop());
        inboxRunner.start();
        cleanups.push(() => inboxRunner.stop());
    });

    afterEach(async function () {
        const undone = cleanups.reverse();
        cleanups = [];

        for (const cleanup of undone) {
            await cleanup();
        }
    });

    it("answers a command and a document with the calls the handlers make, and ctx.reply() resolves to the sent message", async function () {
        await store.pushBatch([commandInput(1, FIRST_USER, "/start"), documentInput(2, FIRST_USER)]);

        await waitUntilDone([1, 2]);

        expect(fakeBotApi.calls).to.deep.equal([
            { method: "getMe", payload: {} },
            { method: "sendMessage", payload: { chat_id: FIRST_USER, text: welcomeReply } },
            { method: "sendMessage", payload: { chat_id: FIRST_USER, text: notTextReply } },
        ]);
        const replies = answers.filter((answer) => answer.method === "sendMessage").map((answer) => answer.result);
        expect(replies).to.deep.equal(fakeBotApi.sentMessages);
        expect(await outboxStatuses()).to.deep.equal(["done", "done"]);
        expectNoProblemLogs();
    });

    it("handles the updates of a group in their order", async function () {
        await store.pushBatch([
            commandInput(1, FIRST_USER, "/start"),
            textInput(2, FIRST_USER, "first"),
            commandInput(3, FIRST_USER, "/start"),
            textInput(4, FIRST_USER, "second"),
        ]);

        await waitUntilDone([1, 2, 3, 4]);

        expect(fakeBotApi.sendsTo(FIRST_USER).map((call) => call.payload["text"])).to.deep.equal([
            welcomeReply,
            "first",
            welcomeReply,
            "second",
        ]);
        expectNoProblemLogs();
    });

    // Each handler awaits its reply, and the fake Bot API answers neither reply before both have
    // come: the handlers of the two groups run at the same time.
    it("handles the updates of different groups in parallel", async function () {
        fakeBotApi.holdSendsUntilAllCome([FIRST_USER, SECOND_USER]);
        await store.pushBatch([commandInput(1, FIRST_USER, "/start"), commandInput(2, SECOND_USER, "/start")]);

        await waitUntilDone([1, 2]);

        expect(fakeBotApi.sendEvents.map((event) => event.kind)).to.deep.equal(["came", "came", "answered", "answered"]);
        expectNoProblemLogs();
    });

    it("retries an update whose handler failed on a lost database connection", async function () {
        sessionStorage.failReads(FIRST_USER, 1);
        await store.push(commandInput(1, FIRST_USER, "/start"));

        await waitUntilDone([1]);

        const [update] = await updateRows();
        expect(update?.attempts.map(({ error }) => (error === null ? null : { kind: error["kind"], code: error["code"] }))).to.deep.equal([
            { kind: "transient", code: "ECONNRESET" },
            null,
        ]);
        expect(fakeBotApi.sendsTo(FIRST_USER).map((call) => call.payload["text"])).to.deep.equal([welcomeReply]);
        expectNoProblemLogs();
    });

    it("blocks the group of an update whose handler keeps failing, while the other groups go on", async function () {
        sessionStorage.failReads(FIRST_USER, Number.POSITIVE_INFINITY);
        await store.pushBatch([
            commandInput(1, FIRST_USER, "/start"),
            textInput(2, FIRST_USER, "behind the failing one"),
            commandInput(3, SECOND_USER, "/start"),
        ]);

        await waitUntil(
            async () => (await groupState(FIRST_USER)) === InboxGroupState.Blocked,
            "the group of the first user was expected to be blocked",
        );
        // Pushed after the block: the runner goes on handling the other groups.
        await store.push(textInput(4, SECOND_USER, "after the block"));
        await waitUntilDone([3, 4]);

        const [failed, behind] = await updateRows();
        expect(failed?.status).to.equal(InboxStatus.Failed);
        expect(failed?.attempts.map(({ error }) => error?.["kind"])).to.deep.equal(Array(MAX_ATTEMPTS).fill("transient"));
        expect(behind?.status).to.equal(InboxStatus.Pending);
        expect(fakeBotApi.sendsTo(FIRST_USER)).to.deep.equal([]);
        expect(fakeBotApi.sendsTo(SECOND_USER).map((call) => call.payload["text"])).to.deep.equal([welcomeReply, "after the block"]);
        expect(logger.errors.map((record) => record.message)).to.deep.equal(["Inbox group is blocked by a failed update."]);
        expect([...logger.criticals, ...logger.warnings]).to.deep.equal([]);
    });

    async function clearTables(): Promise<void> {
        await database.sql`TRUNCATE telegram_inbox, telegram_inbox_groups, telegram_outbox, telegram_outbox_chats, sessions, users RESTART IDENTITY`;
        // Another spec may leave the bot paused or its next send ahead.
        await database.sql`
            UPDATE telegram_bot_limits
            SET next_send_at = now() - interval '1 hour',
                paused_until = NULL
        `;
    }

    // The texts the handlers reply with, translated as the bot translates them for a user without a
    // language.
    async function expectedReplies(): Promise<{ welcomeReply: string; notTextReply: string }> {
        const translate = (await createFluent(path.resolve(__dirname, "../../../src/telegram"))).withLocale(DEFAULT_LOCALE);
        const formats = container.get<ConvertorFactory>(Tokens.Font.Convertor.Factory).getSupportedExtensions().join(", ");

        return {
            welcomeReply: translate("start-conversation-welcome", { formats: formats }),
            notTextReply: translate("start-conversation-not-text"),
        };
    }

    function expectNoProblemLogs(): void {
        expect([...logger.criticals, ...logger.errors, ...logger.warnings]).to.deep.equal([]);
    }

    async function waitUntilDone(updateIds: number[]): Promise<void> {
        await waitUntil(async () => {
            const rows = await updateRows();

            return updateIds.every((updateId) => rows.some((row) => Number(row.update_id) === updateId && row.status === InboxStatus.Done));
        }, `updates ${updateIds.join(", ")} were expected to be done`);
    }

    async function updateRows(): Promise<UpdateRow[]> {
        return database.sql<UpdateRow[]>`
            SELECT update_id, status, attempts
            FROM telegram_inbox
            ORDER BY update_id
        `;
    }

    async function groupState(userId: number): Promise<string | undefined> {
        const [row] = await database.sql<{ state: string }[]>`
            SELECT state FROM telegram_inbox_groups WHERE user_id = ${userId} AND chat_id = ${userId}
        `;

        return row?.state;
    }

    async function outboxStatuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_outbox ORDER BY id`;

        return rows.map((row) => row.status);
    }
});

// grammY takes the API root of an Api only when it builds one, and Bot builds its own from the token
// alone. This transformer stands for the network of that Api: the calls that pass the outbox, getMe
// and setMyCommands, go to the fake Bot API.
function sendToFakeBotApi(apiRoot: string): Transformer<RawApi> {
    return async (_prev, method, payload) => {
        const response = await fetch(`${apiRoot}/bot${TOKEN}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload ?? {}),
        });

        return (await response.json()) as ApiResponse<never>;
    };
}

// grammY copies the transformers of bot.api into the Api of every update, the last one installed
// outermost, so this one sees what the call of a handler resolves to.
function recordAnswers(answers: BotApiAnswer[]): Transformer<RawApi> {
    return async (prev, method, payload, signal) => {
        const response = await prev(method, payload, signal);

        if (response.ok) {
            answers.push({ method: method, result: response.result });
        }

        return response;
    };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function commandInput(updateId: number, userId: number, command: string): InboxUpdateInput {
    const entities: MessageEntity[] = [{ type: "bot_command", offset: 0, length: command.length }];

    return messageInputWith(updateId, userId, { text: command, entities: entities });
}

function textInput(updateId: number, userId: number, text: string): InboxUpdateInput {
    return messageInput(updateId, userId, userId, text);
}

function documentInput(updateId: number, userId: number): InboxUpdateInput {
    const document: Document = { file_id: "file-id", file_unique_id: "file-unique-id", file_name: "font.ttf" };

    return messageInputWith(updateId, userId, { document: document });
}

// A message of the user in their private chat, with its group, as messageInput() of the store spec
// makes it, but with content a text alone does not give.
function messageInputWith(
    updateId: number,
    userId: number,
    content: { text: string; entities?: MessageEntity[] } | { document: Document },
): InboxUpdateInput {
    const message = {
        message_id: updateId,
        date: 0,
        chat: { id: userId, type: "private", first_name: "User" },
        from: { id: userId, is_bot: false, first_name: "User" },
        ...content,
    } as NonNullable<Update["message"]>;

    return { userId: userId, chatId: userId, update: { update_id: updateId, message: message } };
}
