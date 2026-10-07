import "reflect-metadata";
import { expect } from "chai";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { container } from "app/bootstrap/container/container";
import type { Database } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { InvalidConfigError, RuntimeError } from "app/shared/errors";
import { sleep } from "app/shared/utils";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import type { Bot } from "app/telegram/bot/bot";
import type { OutboxRunner } from "app/telegram/outbox/outbox-runner";
import type { OutboxMaintenance } from "app/telegram/outbox/maintenance/outbox-maintenance";
import type { InboxPollingSource } from "app/telegram/inbox/inbox-polling-source";
import type { InboxRunner } from "app/telegram/inbox/inbox-runner";
import type { InboxMaintenance } from "app/telegram/inbox/maintenance/inbox-maintenance";
import { fillApplicationContext, resetApplicationContext } from "test/bootstrap/application/application-context.helper";

type Log = {
    level: keyof Logger;
    message: string;
    payload: UnknownObject | undefined;
};

describe("Application", function () {
    // The order of the start and of the stop is what the spec pins down, so every stub writes its
    // calls into one shared list.
    const calls: string[] = [];
    const logs: Log[] = [];

    let configValues: Record<string, string>;
    let checkDatabase: () => Promise<void>;
    let stopInboxPollingSource: () => Promise<void>;
    let stopInboxRunner: () => Promise<void>;
    let stopOutboxRunner: () => Promise<void>;
    let configUnwatches = 0;

    function write(level: keyof Logger): (message: string, payload?: UnknownObject) => void {
        return (message: string, payload?: UnknownObject): void => {
            logs.push({ level: level, message: message, payload: payload });
        };
    }

    const logger: Logger = {
        critical: write("critical"),
        error: write("error"),
        warning: write("warning"),
        info: write("info"),
        debug: write("debug"),
    };

    const database = {
        check: (): Promise<void> => {
            calls.push("database.check");

            return checkDatabase();
        },
    } as unknown as Database;

    const bot = {
        setup: async (): Promise<void> => {
            calls.push("bot.setup");
        },
    } as unknown as Bot;

    const outboxRunner = {
        start: (): void => {
            calls.push("outboxRunner.start");
        },
        stop: (): Promise<void> => {
            calls.push("outboxRunner.stop");

            return stopOutboxRunner();
        },
    } as unknown as OutboxRunner;

    const outboxMaintenance = {
        start: (): void => {
            calls.push("outboxMaintenance.start");
        },
        stop: async (): Promise<void> => {
            calls.push("outboxMaintenance.stop");
        },
    } as unknown as OutboxMaintenance;

    const inboxPollingSource = {
        start: (): void => {
            calls.push("inboxPollingSource.start");
        },
        stop: (): Promise<void> => {
            calls.push("inboxPollingSource.stop");

            return stopInboxPollingSource();
        },
    } as unknown as InboxPollingSource;

    const inboxRunner = {
        start: (): void => {
            calls.push("inboxRunner.start");
        },
        stop: (): Promise<void> => {
            calls.push("inboxRunner.stop");

            return stopInboxRunner();
        },
    } as unknown as InboxRunner;

    const inboxMaintenance = {
        start: (): void => {
            calls.push("inboxMaintenance.start");
        },
        stop: async (): Promise<void> => {
            calls.push("inboxMaintenance.stop");
        },
    } as unknown as InboxMaintenance;

    function resolve<T>(name: string, value: T): () => T {
        return (): T => {
            calls.push(`resolve ${name}`);

            return value;
        };
    }

    // Application takes the context and the global container rather than dependencies through the
    // constructor, so those are what gets stubbed. The real create() would assemble the config from
    // the environment of the process. The real setup() would bind the real classes under the same
    // symbols, and the resolve would fail with "Ambiguous match", while the real close() would close
    // the pool of Database. Everything is put back after the spec: the context and the container are
    // shared by the whole mocha run.
    const originalCreate = ApplicationContext.create.bind(ApplicationContext);
    const originalSetup = container.setup.bind(container);
    const originalClose = container.close.bind(container);

    before(function () {
        ApplicationContext.create = async (): Promise<void> => {
            calls.push("context.create");
            await fillApplicationContext(configValues, logger);

            // Removing the watching is counted separately from the shared list of calls: the real
            // container with a fake source removes it without a trace, and the order of the stop is
            // pinned down by the other tests — they do not need a record about the configuration.
            ApplicationContext.getConfigContainer().unwatch = (): void => {
                configUnwatches += 1;
            };
        };
        container.setup = async (): Promise<void> => {
            calls.push("container.setup");
        };
        container.close = async (): Promise<void> => {
            calls.push("container.close");
        };
    });

    after(function () {
        ApplicationContext.create = originalCreate;
        container.setup = originalSetup;
        container.close = originalClose;
    });

    beforeEach(function () {
        calls.length = 0;
        logs.length = 0;
        configUnwatches = 0;
        configValues = {};
        checkDatabase = async (): Promise<void> => undefined;
        stopInboxPollingSource = async (): Promise<void> => undefined;
        stopInboxRunner = async (): Promise<void> => undefined;
        stopOutboxRunner = async (): Promise<void> => undefined;

        container.snapshot();
        container.bind<Database>(Tokens.Platform.Database).toConstantValue(database);
        container.bind<Bot>(Tokens.Bot.Bot).toDynamicValue(resolve("Bot", bot));
        container.bind<OutboxRunner>(Tokens.Bot.Outbox.Runner).toDynamicValue(resolve("OutboxRunner", outboxRunner));
        container.bind<OutboxMaintenance>(Tokens.Bot.Outbox.Maintenance).toDynamicValue(resolve("OutboxMaintenance", outboxMaintenance));
        container.bind<InboxRunner>(Tokens.Bot.Inbox.Runner).toDynamicValue(resolve("InboxRunner", inboxRunner));
        container.bind<InboxMaintenance>(Tokens.Bot.Inbox.Maintenance).toDynamicValue(resolve("InboxMaintenance", inboxMaintenance));
        container
            .bind<InboxPollingSource>(Tokens.Bot.Inbox.PollingSource)
            .toDynamicValue(resolve("InboxPollingSource", inboxPollingSource));
    });

    afterEach(function () {
        container.restore();
        resetApplicationContext();
    });

    // The calls made on the way to the state needed are dropped: they are pinned down by the tests
    // of setup() and run().
    async function setUp(): Promise<Application> {
        const application = new Application();
        await application.setup();

        calls.length = 0;
        logs.length = 0;

        return application;
    }

    async function start(): Promise<Application> {
        const application = await setUp();
        await application.run();

        calls.length = 0;
        logs.length = 0;

        return application;
    }

    function caught(promise: Promise<unknown>): Promise<unknown> {
        return promise.then(
            () => expect.fail("the promise was expected to reject"),
            (error: unknown) => error,
        );
    }

    describe("setup()", function () {
        it("builds the context and the container, checks the database and only then resolves and sets up the bot", async function () {
            await new Application().setup();

            expect(calls).to.deep.equal([
                "context.create",
                "container.setup",
                "database.check",
                "resolve Bot",
                "resolve OutboxRunner",
                "resolve OutboxMaintenance",
                "resolve InboxRunner",
                "resolve InboxMaintenance",
                "resolve InboxPollingSource",
                "bot.setup",
            ]);
        });

        it("logs every step on info", async function () {
            await new Application().setup();

            expect(logs).to.deep.equal([
                { level: "info", message: "Setup container...", payload: undefined },
                { level: "info", message: "Container successfully setup.", payload: undefined },
                { level: "info", message: "Check database connection...", payload: undefined },
                { level: "info", message: "Database connection is alive.", payload: undefined },
            ]);
        });

        it("does nothing when called again", async function () {
            const application = await setUp();

            await application.setup();

            expect(calls).to.deep.equal([]);
        });

        it("waits for the setup in progress instead of starting another one", async function () {
            const check = Promise.withResolvers<void>();
            checkDatabase = (): Promise<void> => check.promise;
            const application = new Application();

            const first = application.setup();
            const second = application.setup().then(() => calls.push("second setup resolved"));
            check.resolve();
            await Promise.all([first, second]);

            expect(calls).to.deep.equal([
                "context.create",
                "container.setup",
                "database.check",
                "resolve Bot",
                "resolve OutboxRunner",
                "resolve OutboxMaintenance",
                "resolve InboxRunner",
                "resolve InboxMaintenance",
                "resolve InboxPollingSource",
                "bot.setup",
                "second setup resolved",
            ]);
        });

        it("does not resolve the bot and stays not set up when the database check fails", async function () {
            const error = new Error("connection refused");
            checkDatabase = (): Promise<void> => Promise.reject(error);
            const application = new Application();

            expect(await caught(application.setup())).to.equal(error);
            expect(calls).to.deep.equal(["context.create", "container.setup", "database.check"]);
            expect(await caught(application.run())).to.be.instanceOf(RuntimeError);
        });

        // The instance is single-use: the container does not survive a second setup() after
        // close().
        it("does nothing once the application has been stopped", async function () {
            const application = await setUp();
            await application.stop();
            calls.length = 0;
            logs.length = 0;

            await application.setup();

            expect(calls).to.deep.equal([]);
            expect(logs).to.deep.equal([]);
        });

        it("rejects again with the same error without repeating a failed setup", async function () {
            const error = new Error("connection refused");
            checkDatabase = (): Promise<void> => Promise.reject(error);
            const application = new Application();
            await caught(application.setup());
            calls.length = 0;

            expect(await caught(application.setup())).to.equal(error);
            expect(calls).to.deep.equal([]);
        });
    });

    describe("run()", function () {
        it("rejects before setup without starting anything", async function () {
            const error = await caught(new Application().run());

            expect(error).to.be.instanceOf(RuntimeError);
            expect((error as RuntimeError).message).to.equal("Application is not set up!");
            expect(calls).to.deep.equal([]);
        });

        // The outbox first: the handlers of the updates await its results. The polling source last.
        it("starts the outbox, then the inbox, then the polling source, and logs the start", async function () {
            const application = await setUp();

            await application.run();

            expect(calls).to.deep.equal([
                "outboxRunner.start",
                "outboxMaintenance.start",
                "inboxRunner.start",
                "inboxMaintenance.start",
                "inboxPollingSource.start",
            ]);
            expect(logs).to.deep.equal([{ level: "info", message: "Application is successfully started.", payload: undefined }]);
        });

        it("rejects when already running without starting anything again", async function () {
            const application = await start();

            const error = await caught(application.run());

            expect(error).to.be.instanceOf(RuntimeError);
            expect((error as RuntimeError).message).to.equal("Application is already running!");
            expect(calls).to.deep.equal([]);
        });

        it("starts nothing once the application has been stopped", async function () {
            const application = await setUp();
            await application.stop();
            calls.length = 0;
            logs.length = 0;

            await application.run();

            expect(calls).to.deep.equal([]);
            expect(logs).to.deep.equal([]);
        });
    });

    describe("stop()", function () {
        const FULL_STOP = [
            "inboxPollingSource.stop",
            "inboxRunner.stop",
            "inboxMaintenance.stop",
            "outboxRunner.stop",
            "outboxMaintenance.stop",
            "container.close",
        ];

        it("does nothing before setup", async function () {
            await new Application().stop();

            expect(calls).to.deep.equal([]);
            expect(logs).to.deep.equal([]);
        });

        it("only closes the container when the application is not running", async function () {
            const application = await setUp();

            await application.stop();

            expect(calls).to.deep.equal(["container.close"]);
        });

        it("stops the polling source, then the inbox, then the outbox, and closes the container", async function () {
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(FULL_STOP);
            expect(logs).to.deep.equal([
                { level: "info", message: "Stop application...", payload: undefined },
                { level: "info", message: "Application is successfully stopped.", payload: undefined },
            ]);
        });

        // A runner waits for its work in flight up to its own deadline, and what follows it waits for
        // the runner. The pause is long enough for the stop to reach the runner and wait there.
        const RUNNER_STOP_REACHED_MS = 10;

        // The handlers in flight await the results of the outbox: stopped first, the outbox would leave
        // them waiting for nothing.
        it("drains the inbox before it stops the outbox", async function () {
            const inboxStopped = Promise.withResolvers<void>();
            stopInboxRunner = (): Promise<void> => inboxStopped.promise;
            const application = await start();

            const stopped = application.stop();
            await sleep(RUNNER_STOP_REACHED_MS);
            const callsWhileWaiting = [...calls];
            inboxStopped.resolve();
            await stopped;

            expect(callsWhileWaiting).to.deep.equal(["inboxPollingSource.stop", "inboxRunner.stop"]);
            expect(calls).to.deep.equal(FULL_STOP);
        });

        it("waits for the outbox runner to stop before it stops the maintenance", async function () {
            const outboxStopped = Promise.withResolvers<void>();
            stopOutboxRunner = (): Promise<void> => outboxStopped.promise;
            const application = await start();

            const stopped = application.stop();
            await sleep(RUNNER_STOP_REACHED_MS);
            const callsWhileWaiting = [...calls];
            outboxStopped.resolve();
            await stopped;

            expect(callsWhileWaiting).to.deep.equal([
                "inboxPollingSource.stop",
                "inboxRunner.stop",
                "inboxMaintenance.stop",
                "outboxRunner.stop",
            ]);
            expect(calls).to.deep.equal(FULL_STOP);
        });

        // The source has no deadline of its own: a push stuck on the database would hold the whole stop.
        it("waits for the polling source no longer than its timeout, warns and stops the rest", async function () {
            configValues = { INBOX_POLLING_STOP_TIMEOUT: "20" };
            stopInboxPollingSource = (): Promise<void> => new Promise(() => undefined);
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(FULL_STOP);
            expect(logs.filter(({ level }) => level === "warning")).to.deep.equal([
                {
                    level: "warning",
                    message: "Inbox polling stop timeout is over, the source was left stopping.",
                    payload: { timeoutMs: 20 },
                },
            ]);
            expect(logs.map(({ message }) => message)).to.include("Application is successfully stopped.");
        });

        it("does nothing on a second stop after the first one has finished", async function () {
            const application = await start();
            await application.stop();
            calls.length = 0;
            logs.length = 0;

            await application.stop();

            expect(calls).to.deep.equal([]);
            expect(logs).to.deep.equal([]);
        });

        it("rejects again with the same error without repeating a failed stop", async function () {
            const error = new Error("runner stop failed");
            stopInboxRunner = (): Promise<void> => Promise.reject(error);
            const application = await start();
            expect(await caught(application.stop())).to.equal(error);
            calls.length = 0;
            logs.length = 0;

            expect(await caught(application.stop())).to.equal(error);
            expect(calls).to.deep.equal([]);
            expect(logs).to.deep.equal([]);
        });

        // This is how app.ts handles a signal of the other kind that arrived during the stop: a
        // second stop() returning before the first would let process.exit(0) cut the stop short.
        it("waits for the stop in progress instead of starting another one", async function () {
            const inboxStopped = Promise.withResolvers<void>();
            stopInboxRunner = (): Promise<void> => inboxStopped.promise;
            const application = await start();

            const first = application.stop();
            const second = application.stop().then(() => calls.push("second stop resolved"));
            inboxStopped.resolve();
            await Promise.all([first, second]);

            expect(calls).to.deep.equal([...FULL_STOP, "second stop resolved"]);
            expect(logs.map(({ message }) => message)).to.deep.equal(["Stop application...", "Application is successfully stopped."]);
        });

        // A signal in the middle of setup(): bootstrap() in app.ts calls run() after the setup, and
        // that one must not start an application that is already stopping.
        it("waits for the setup in progress, then only closes the container while run() starts nothing", async function () {
            const check = Promise.withResolvers<void>();
            checkDatabase = (): Promise<void> => check.promise;
            const application = new Application();

            const started = application.setup().then(() => application.run());
            const stopped = application.stop();
            check.resolve();
            await Promise.all([started, stopped]);

            expect(calls).to.deep.equal([
                "context.create",
                "container.setup",
                "database.check",
                "resolve Bot",
                "resolve OutboxRunner",
                "resolve OutboxMaintenance",
                "resolve InboxRunner",
                "resolve InboxMaintenance",
                "resolve InboxPollingSource",
                "bot.setup",
                "container.close",
            ]);
            expect(logs.map(({ message }) => message)).to.include("Application is successfully stopped.");
            expect(logs.map(({ message }) => message)).to.not.include("Application is successfully started.");
        });

        // The failure comes to fail() from both paths of app.ts with one error; the first call ends
        // the process, so there is one critical and the exit code is 1, not the exit(0) of the
        // stop.
        it("rejects with the error of the setup in progress when it fails", async function () {
            const error = new Error("connection refused");
            const check = Promise.withResolvers<void>();
            checkDatabase = (): Promise<void> => check.promise;
            const application = new Application();

            const setup = caught(application.setup());
            const stop = caught(application.stop());
            check.reject(error);

            expect(await setup).to.equal(error);
            expect(await stop).to.equal(error);
            expect(calls).to.deep.equal(["context.create", "container.setup", "database.check"]);
        });

        // Without the context the stop has neither a logger nor a deadline: were it not to wait for
        // the assembly, it would fail with a TypeError on the very first log instead of handing back
        // the failure of the configuration, which is what fail() is to print.
        it("rejects with the config error when the context fails while the stop waits for it", async function () {
            configValues = { NODE_ENV: "prod" };
            const application = new Application();

            const setup = caught(application.setup());
            const stop = caught(application.stop());

            expect(await setup).to.be.instanceOf(InvalidConfigError);
            expect(await stop).to.equal(await setup);
            expect(calls).to.deep.equal(["context.create"]);
            expect(logs).to.deep.equal([]);
        });

        it("waits for the setup in progress no longer than the graceful shutdown timeout", async function () {
            configValues = {
                GRACEFUL_SHUTDOWN_TIMEOUT: "20",
                INBOX_POLLING_STOP_TIMEOUT: "0",
                INBOX_STOP_TIMEOUT: "0",
                OUTBOX_STOP_TIMEOUT: "0",
            };
            checkDatabase = (): Promise<void> => new Promise(() => undefined);
            const application = new Application();

            void application.setup();
            await application.stop();

            expect(calls).to.deep.equal(["context.create", "container.setup", "database.check"]);
            expect(logs.filter(({ level }) => level === "warning")).to.deep.equal([
                {
                    level: "warning",
                    message: "Graceful shutdown timeout is over, the shutdown was cut short.",
                    payload: { timeout: 20 },
                },
            ]);
        });

        // The watching of the configuration is removed before the overall deadline and outside it: a
        // poll left behind would rebuild the configuration of an application already closed and would
        // hold the event loop.
        it("unwatches the config even when the shutdown timeout is over", async function () {
            configValues = {
                GRACEFUL_SHUTDOWN_TIMEOUT: "20",
                INBOX_POLLING_STOP_TIMEOUT: "0",
                INBOX_STOP_TIMEOUT: "0",
                OUTBOX_STOP_TIMEOUT: "0",
            };
            stopInboxRunner = (): Promise<void> => new Promise(() => undefined);
            const application = await start();

            await application.stop();

            expect(configUnwatches).to.equal(1);
            expect(logs.filter(({ level }) => level === "warning").map(({ message }) => message)).to.deep.equal([
                "Graceful shutdown timeout is over, the shutdown was cut short.",
            ]);
        });

        // The abandoned step goes on running until process.exit(0) in app.ts cuts it short.
        it("returns with a warning when the shutdown outlives the graceful shutdown timeout", async function () {
            configValues = {
                GRACEFUL_SHUTDOWN_TIMEOUT: "20",
                INBOX_POLLING_STOP_TIMEOUT: "0",
                INBOX_STOP_TIMEOUT: "0",
                OUTBOX_STOP_TIMEOUT: "0",
            };
            stopInboxRunner = (): Promise<void> => new Promise(() => undefined);
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(["inboxPollingSource.stop", "inboxRunner.stop"]);
            expect(logs.filter(({ level }) => level === "warning")).to.deep.equal([
                {
                    level: "warning",
                    message: "Graceful shutdown timeout is over, the shutdown was cut short.",
                    payload: { timeout: 20 },
                },
            ]);
            expect(logs.map(({ message }) => message)).to.not.include("Application is successfully stopped.");
        });
    });
});
