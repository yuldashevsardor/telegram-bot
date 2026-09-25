import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import type { NextFunction, RawApi, StorageAdapter, Transformer } from "grammy";
import { BotError } from "grammy";
import type { Chat, Update, UserFromGetMe } from "@grammyjs/types";
import { Bot } from "app/telegram/bot/bot";
import type { BotSettings, Context, Conversation } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { UnknownObject } from "app/shared/types";
import { InvalidConfigError, RuntimeError } from "app/shared/errors";
import type { SessionPayload } from "app/telegram/session/session.types";
import { Command } from "app/telegram/command/command";
import { Middleware } from "app/telegram/middleware/middleware";
import { ConversationHandler } from "app/telegram/conversation/conversation-handler";
import { HasSessionKeyFilter } from "app/telegram/filter/has-session-key.filter";
import { IsPrivateChatFilter } from "app/telegram/filter/is-private-chat.filter";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE, LOCALES } from "app/telegram/locale/locale.types";

type LogRecord = { level: keyof Logger; message: string; payload: UnknownObject | undefined };

type ApiCall = { method: string; payload: Record<string, unknown> };

type CommandHook = (ctx: Context) => Promise<void>;

type Harness = {
    bot: Bot;
    events: string[];
    logs: LogRecord[];
    calls: ApiCall[];
    // The updates the next getUpdates gives back; an empty queue means long polling until cancelled.
    updates: Update[];
    onCommand: { hook: CommandHook };
};

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

const SETTINGS: BotSettings = { token: "test-token", gracefulShutdown: { timeout: 50 } };

const USER_ID = 42;

class RecordingHasSessionKeyFilter extends HasSessionKeyFilter {
    public constructor(logger: Logger, private readonly events: string[]) {
        super(logger);
    }

    protected override handle(ctx: Context): boolean {
        this.events.push("HasSessionKeyFilter");

        return super.handle(ctx);
    }
}

class RecordingIsPrivateChatFilter extends IsPrivateChatFilter {
    public constructor(logger: Logger, private readonly events: string[]) {
        super(logger);
    }

    protected override handle(ctx: Context): ctx is Context & { chat: Chat.PrivateChat } {
        this.events.push("IsPrivateChatFilter");

        return super.handle(ctx);
    }
}

class RecordingMiddleware extends Middleware {
    public constructor(private readonly name: string, private readonly events: string[]) {
        super();
    }

    protected handle(_ctx: Context, next: NextFunction): Promise<void> {
        this.events.push(this.name);

        return next();
    }
}

class RecordingCommand extends Command {
    public constructor(
        public readonly command: string,
        public readonly descriptionKey: string,
        private readonly events: string[],
        private readonly onCommand: { hook: CommandHook },
    ) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        this.events.push(`/${this.command}`);

        await this.onCommand.hook(ctx);
    }
}

class RecordingConversation extends ConversationHandler {
    public readonly name: string = "recording";

    public constructor(private readonly events: string[]) {
        super();
    }

    protected async run(conversation: Conversation): Promise<void> {
        const next = await conversation.wait();

        this.events.push(`conversation got ${next.message?.text}`);
    }
}

function buildLogger(logs: LogRecord[]): Logger {
    const write =
        (level: keyof Logger) =>
        (message: string, payload?: UnknownObject): void => {
            logs.push({ level: level, message: message, payload: payload });
        };

    return { critical: write("critical"), error: write("error"), warning: write("warning"), info: write("info"), debug: write("debug") };
}

// An in-memory session storage that copies the value, the way JSONB does in PgsqlStorage.
function buildStorage(events: string[]): StorageAdapter<SessionPayload> {
    const rows = new Map<string, string>();

    return {
        read: async (key: string): Promise<SessionPayload | undefined> => {
            events.push("session read");
            const row = rows.get(key);

            return row === undefined ? undefined : (JSON.parse(row) as SessionPayload);
        },
        write: async (key: string, value: SessionPayload): Promise<void> => {
            events.push("session write");
            rows.set(key, JSON.stringify(value));
        },
        delete: async (key: string): Promise<void> => {
            rows.delete(key);
        },
    };
}

// Telegram is stubbed by a transformer of the grammY client: grammY builds the Api of an update
// with the same transformers as bot.grammy.api has, so not a single call reaches the network.
function useFakeTelegram(harness: Harness): void {
    const transformer: Transformer<RawApi> = async (_prev, method, payload, signal) => {
        harness.calls.push({ method: method, payload: payload as Record<string, unknown> });

        if (method === "getMe") {
            return { ok: true, result: ME } as never;
        }

        if (method === "getUpdates") {
            return { ok: true, result: await nextUpdates(harness, signal) } as never;
        }

        return { ok: true, result: true } as never;
    };

    harness.bot.grammy.api.config.use(transformer);
}

async function nextUpdates(harness: Harness, signal: Parameters<Transformer<RawApi>>[3]): Promise<Update[]> {
    if (harness.updates.length > 0) {
        return harness.updates.splice(0);
    }

    return new Promise<Update[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
            harness.events.push("getUpdates aborted");
            reject(new RuntimeError("getUpdates is aborted"));
        });
    });
}

function build(settings: BotSettings = SETTINGS): Harness {
    const events: string[] = [];
    const logs: LogRecord[] = [];
    const logger = buildLogger(logs);
    const onCommand = { hook: async (): Promise<void> => undefined };

    const bot = new Bot(
        logger,
        buildStorage(events),
        new RecordingHasSessionKeyFilter(logger, events),
        new RecordingIsPrivateChatFilter(logger, events),
        new RecordingMiddleware("RequestContextMiddleware", events),
        new RecordingMiddleware("TelegramCallApiMiddleware", events),
        new RecordingMiddleware("ResponseTimeMiddleware", events),
        new RecordingMiddleware("RequestLogMiddleware", events),
        new RecordingMiddleware("FillUserToContextMiddleware", events),
        new RecordingConversation(events),
        new RecordingCommand("start", "start-command-description", events, onCommand),
        new RecordingCommand("bulk_messages", "bulk-messages-command-description", events, onCommand),
        new RecordingCommand("font_generator", "font-generator-command-description", events, onCommand),
        settings,
    );

    const harness: Harness = { bot: bot, events: events, logs: logs, calls: [], updates: [], onCommand: onCommand };
    useFakeTelegram(harness);

    return harness;
}

async function setUp(): Promise<Harness> {
    const harness = build();
    await harness.bot.setup();
    harness.bot.grammy.botInfo = ME;
    harness.events.length = 0;
    harness.calls.length = 0;

    return harness;
}

let updateId = 0;

function message(text: string, options: { chat?: Chat.PrivateChat | Chat.GroupChat; languageCode?: string } = {}): Update {
    const isCommand = text.startsWith("/");

    return {
        update_id: ++updateId,
        message: {
            message_id: updateId,
            date: 0,
            chat: options.chat ?? { id: USER_ID, type: "private", first_name: "User" },
            from: {
                id: USER_ID,
                is_bot: false,
                first_name: "User",
                ...(options.languageCode === undefined ? {} : { language_code: options.languageCode }),
            },
            text: text,
            ...(isCommand ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.length }] } : {}),
        },
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;

    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new RuntimeError("Condition is not met in time");
        }

        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

describe("Bot", function () {
    it("refuses an empty token", function () {
        expect(() => build({ ...SETTINGS, token: "" })).to.throw(InvalidConfigError, "Bot token cannot be empty!");
    });

    describe("setup", function () {
        it("publishes the command menu on the default locale, then on every other one", async function () {
            const { bot, calls } = build();
            await bot.setup();
            const fluent = await createFluent(path.resolve(__dirname, "../../src/telegram"));
            const menu = (locale: string): Array<{ command: string; description: string }> => {
                const translate = fluent.withLocale(locale);

                return [
                    { command: "start", description: translate("start-command-description") },
                    { command: "bulk_messages", description: translate("bulk-messages-command-description") },
                    { command: "font_generator", description: translate("font-generator-command-description") },
                ];
            };

            const otherLocales = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

            expect(calls.filter((call) => call.method === "setMyCommands").map((call) => call.payload)).to.deep.equal([
                { commands: menu(DEFAULT_LOCALE) },
                ...otherLocales.map((locale) => ({ commands: menu(locale), language_code: locale })),
            ]);
            expect(menu("en")[0]?.description).to.not.equal(menu("ru")[0]?.description);
        });

        it("builds the pipeline only once", async function () {
            const harness = build();
            await harness.bot.setup();
            await harness.bot.setup();
            harness.bot.grammy.botInfo = ME;

            await harness.bot.grammy.handleUpdate(message("/start"));

            expect(harness.calls.filter((call) => call.method === "setMyCommands")).to.have.lengthOf(LOCALES.length);
            expect(harness.events.filter((event) => event === "/start")).to.have.lengthOf(1);
        });

        it("logs every step of the pipeline on debug", async function () {
            const { bot, logs } = build();

            await bot.setup();

            expect(logs.filter((log) => log.level === "debug")).to.deep.equal([
                {
                    level: "debug",
                    message: "Setup filters...",
                    payload: { filters: ["RecordingHasSessionKeyFilter", "RecordingIsPrivateChatFilter"] },
                },
                { level: "debug", message: "Filters successfully setup.", payload: undefined },
                { level: "debug", message: "Setup middlewares...", payload: undefined },
                { level: "debug", message: "Middlewares successfully setup.", payload: undefined },
                { level: "debug", message: "Setup conversations...", payload: undefined },
                { level: "debug", message: "Conversations successfully setup.", payload: undefined },
                { level: "debug", message: "Setup commands...", payload: undefined },
                { level: "debug", message: "Commands successfully setup.", payload: undefined },
            ]);
        });
    });

    describe("pipeline", function () {
        it("runs a private message through the filters, the session, the middlewares and the commands in this order", async function () {
            const { bot, events } = await setUp();

            await bot.grammy.handleUpdate(message("/start"));

            expect(events).to.deep.equal([
                "HasSessionKeyFilter",
                "IsPrivateChatFilter",
                "session read",
                "RequestContextMiddleware",
                "TelegramCallApiMiddleware",
                "ResponseTimeMiddleware",
                "RequestLogMiddleware",
                "FillUserToContextMiddleware",
                "/start",
                "session write",
            ]);
        });

        // Step 2 stands above session(): otherwise a group update would have created a row in sessions before being dropped.
        it("drops a group message before the session is read", async function () {
            const { bot, events } = await setUp();

            await bot.grammy.handleUpdate(message("/start", { chat: { id: -100, type: "group", title: "Group" } }));

            expect(events).to.deep.equal(["HasSessionKeyFilter", "IsPrivateChatFilter"]);
        });

        // IsPrivateChatFilter drops silently, so an update without a session key is seen first by
        // HasSessionKeyFilter with its warning.
        it("drops an update without a session key before IsPrivateChatFilter sees it", async function () {
            const { bot, events, logs } = await setUp();

            await bot.grammy.handleUpdate({
                update_id: ++updateId,
                channel_post: { message_id: 1, date: 0, chat: { id: -100, type: "channel", title: "Channel" }, text: "post" },
            });

            expect(events).to.deep.equal(["HasSessionKeyFilter"]);
            expect(logs.filter((log) => log.level === "warning")).to.have.lengthOf(1);
        });

        it("gives the commands the translation of the update locale", async function () {
            const harness = await setUp();
            const fluent = await createFluent(path.resolve(__dirname, "../../src/telegram"));
            let translated: string | undefined = undefined;
            harness.onCommand.hook = async (ctx: Context): Promise<void> => {
                translated = ctx.t("start-command-description");
            };

            await harness.bot.grammy.handleUpdate(message("/start", { languageCode: "en" }));

            expect(translated).to.equal(fluent.withLocale("en")("start-command-description"));
        });

        // sequentialize() above session(): the second update of the same user reads the session
        // only after the first one has written it, otherwise it would wipe out the first one's state.
        it("reads the session of a user only after the previous update of this user has written it", async function () {
            const harness = await setUp();
            let release = (): void => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            harness.onCommand.hook = async (): Promise<void> => {
                harness.onCommand.hook = async (): Promise<void> => undefined;
                await gate;
            };

            const first = harness.bot.grammy.handleUpdate(message("/start"));
            const second = harness.bot.grammy.handleUpdate(message("/start"));
            await new Promise((resolve) => setTimeout(resolve, 10));
            release();
            await Promise.all([first, second]);

            const reads = harness.events.flatMap((event, index) => (event === "session read" ? [index] : []));
            const writes = harness.events.flatMap((event, index) => (event === "session write" ? [index] : []));

            expect(reads).to.have.lengthOf(2);
            expect(writes).to.have.lengthOf(2);
            expect(reads[1]).to.be.greaterThan(writes[0] as number);
        });

        // Step 7 above step 8: an update of a chat inside a conversation goes to wait(), even when it is a command.
        it("hands the next update of a chat inside a conversation to the conversation, not to the commands", async function () {
            const harness = await setUp();
            harness.onCommand.hook = async (ctx: Context): Promise<void> => {
                harness.onCommand.hook = async (): Promise<void> => undefined;
                await ctx.conversation.enter("recording");
            };

            await harness.bot.grammy.handleUpdate(message("/start"));
            await harness.bot.grammy.handleUpdate(message("/font_generator"));

            expect(harness.events).to.include("conversation got /font_generator");
            expect(harness.events).to.not.include("/font_generator");
        });
    });

    describe("run", function () {
        it("refuses to run before setup", async function () {
            const { bot } = build();

            let caught: unknown = undefined;
            await bot.run().catch((error: unknown) => {
                caught = error;
            });

            expect(caught).to.be.instanceOf(RuntimeError);
            expect((caught as RuntimeError).message).to.equal("Bot is not set up!");
        });

        // The list of update types is ALLOWED_UPDATES in bot.ts: without it getUpdates would drag
        // in every type the bot does not serve.
        it("polls only messages", async function () {
            const harness = await setUp();

            await harness.bot.run();
            await waitFor(() => harness.calls.some((call) => call.method === "getUpdates"));
            await harness.bot.stop();

            const getUpdates = harness.calls.find((call) => call.method === "getUpdates");

            expect(getUpdates?.payload["allowed_updates"]).to.deep.equal(["message"]);
        });

        it("logs an error of the pipeline as critical and answers nothing", async function () {
            const harness = await setUp();
            const error = new RuntimeError("command failed");
            harness.onCommand.hook = (): Promise<void> => Promise.reject(error);
            harness.updates.push(message("/start"));

            await harness.bot.run();
            await waitFor(() => harness.logs.some((log) => log.level === "critical"));
            await harness.bot.stop();

            const critical = harness.logs.filter((log) => log.level === "critical");
            const cause = critical[0]?.payload?.["cause"];

            expect(critical).to.have.lengthOf(1);
            expect(critical[0]?.message).to.equal("Unhandled error on bot");
            expect(cause).to.be.instanceOf(BotError);
            expect((cause as BotError).error).to.equal(error);
            expect(harness.calls.filter((call) => call.method !== "getMe" && call.method !== "getUpdates")).to.have.lengthOf(0);
        });
    });

    describe("stop", function () {
        it("does nothing before run", async function () {
            const harness = await setUp();

            await harness.bot.stop();

            expect(harness.logs.map((log) => log.message)).to.include("Bot is not running!");
            expect(harness.calls.filter((call) => call.method === "getUpdates")).to.have.lengthOf(0);
        });

        it("aborts the pending getUpdates and stops within the timeout", async function () {
            const harness = await setUp();

            await harness.bot.run();
            await waitFor(() => harness.calls.some((call) => call.method === "getUpdates"));
            await harness.bot.stop();

            expect(harness.events).to.include("getUpdates aborted");
            expect(harness.logs.filter((log) => log.level === "info").map((log) => log.message)).to.deep.equal([
                "Bot is successfully started.",
                "Stop bot...",
                "Bot is successfully stopped.",
            ]);
            expect(harness.logs.filter((log) => log.level === "warning")).to.have.lengthOf(0);
        });

        it("does nothing on a second stop after the first one has finished", async function () {
            const harness = await setUp();

            await harness.bot.run();
            await waitFor(() => harness.calls.some((call) => call.method === "getUpdates"));
            await harness.bot.stop();
            harness.logs.length = 0;

            await harness.bot.stop();

            expect(harness.logs.map((log) => log.message)).to.deep.equal(["Stop bot...", "Bot is not running!"]);
        });

        describe("when getUpdates does not give way", function () {
            let release = (): void => undefined;

            // Long polling that does not listen for cancellation: the runner will not stop until the request returns.
            async function runStuck(): Promise<Harness> {
                const harness = await setUp();
                const stuck = new Promise<void>((resolve) => {
                    release = resolve;
                });
                harness.bot.grammy.api.config.use(async (prev, method, payload, signal) => {
                    if (method === "getUpdates") {
                        harness.calls.push({ method: method, payload: payload as Record<string, unknown> });
                        await stuck;

                        return { ok: true, result: [] } as never;
                    }

                    return prev(method, payload, signal);
                });

                await harness.bot.run();
                await waitFor(() => harness.calls.some((call) => call.method === "getUpdates"));

                return harness;
            }

            afterEach(function () {
                release();
            });

            it("warns once the timeout is over and leaves the runner stopping", async function () {
                const harness = await runStuck();

                await harness.bot.stop();

                expect(harness.logs.filter((log) => log.level === "warning")).to.deep.equal([
                    {
                        level: "warning",
                        message: "Bot shutdown timeout is over, the runner was left stopping.",
                        payload: { timeout: SETTINGS.gracefulShutdown.timeout },
                    },
                ]);
                expect(harness.logs.map((log) => log.message)).to.include("Bot is successfully stopped.");
            });

            // A repeated signal (SIGINT, then SIGTERM) calls stop() a second time while the first one is still waiting.
            it("does not wait again on a second stop while the first one is waiting", async function () {
                const harness = await runStuck();
                const finished: string[] = [];

                await Promise.all([
                    harness.bot.stop().then(() => finished.push("first")),
                    harness.bot.stop().then(() => finished.push("second")),
                ]);

                expect(finished).to.deep.equal(["second", "first"]);
                expect(harness.logs.filter((log) => log.level === "warning")).to.have.lengthOf(1);
            });
        });
    });
});
