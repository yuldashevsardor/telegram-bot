import "reflect-metadata";
import { expect } from "chai";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { container } from "app/bootstrap/container/container";
import type { Database } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { InvalidConfigError, RuntimeError } from "app/shared/errors";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import type { Bot } from "app/telegram/bot/bot";
import type { Runner } from "app/telegram/outbound-queue/runner/runner";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
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
    let runBot: () => Promise<void>;
    let stopBot: () => Promise<void>;
    let queueSize: () => number;
    let lastQueueSize = 0;
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

    const taskQueue = {
        isEmpty: (): boolean => {
            calls.push("taskQueue.isEmpty");
            lastQueueSize = queueSize();

            return lastQueueSize === 0;
        },
        getTaskCount: (): number => lastQueueSize,
    } as unknown as TaskQueue;

    const runner = {
        run: (): void => {
            calls.push("runner.run");
        },
        stop: (): void => {
            calls.push("runner.stop");
        },
    } as unknown as Runner;

    const bot = {
        setup: async (): Promise<void> => {
            calls.push("bot.setup");
        },
        run: (): Promise<void> => {
            calls.push("bot.run");

            return runBot();
        },
        stop: (): Promise<void> => {
            calls.push("bot.stop");

            return stopBot();
        },
    } as unknown as Bot;

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
        runBot = async (): Promise<void> => undefined;
        stopBot = async (): Promise<void> => undefined;
        queueSize = (): number => 0;

        container.snapshot();
        container.bind<Database>(Tokens.Platform.Database).toConstantValue(database);
        container.bind<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue).toDynamicValue(resolve("TaskQueue", taskQueue));
        container.bind<Runner>(Tokens.Bot.OutboundQueue.Runner).toDynamicValue(resolve("Runner", runner));
        container.bind<Bot>(Tokens.Bot.Bot).toDynamicValue(resolve("Bot", bot));
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
                "resolve TaskQueue",
                "resolve Runner",
                "resolve Bot",
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
                "resolve TaskQueue",
                "resolve Runner",
                "resolve Bot",
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

        it("starts the runner before the bot and logs the start", async function () {
            const application = await setUp();

            await application.run();

            expect(calls).to.deep.equal(["runner.run", "bot.run"]);
            expect(logs).to.deep.equal([{ level: "info", message: "Application is successfully started.", payload: undefined }]);
        });

        // A failure is logged only by fail() in app.ts: a second critical on the same failure would
        // double the alert count.
        it("stops the runner and rethrows without logging when the bot fails to start", async function () {
            const error = new Error("getMe failed");
            runBot = (): Promise<void> => Promise.reject(error);
            const application = await setUp();

            expect(await caught(application.run())).to.equal(error);
            expect(calls).to.deep.equal(["runner.run", "bot.run", "runner.stop"]);
            expect(logs).to.deep.equal([]);
        });

        it("starts again after the bot has failed to start", async function () {
            runBot = (): Promise<void> => Promise.reject(new Error("getMe failed"));
            const application = await setUp();
            await caught(application.run());
            calls.length = 0;
            runBot = async (): Promise<void> => undefined;

            await application.run();

            expect(calls).to.deep.equal(["runner.run", "bot.run"]);
        });

        // Today there is no window between runner.run() and the end of bot.run(): Bot.run() has no
        // await. This test and the next one hold the behaviour of Application in case an await
        // appears there; what the real Bot.stop() would then do with a bot that is not running yet
        // is not something the stub checks.
        it("counts as running while the bot is starting, so a stop in between runs the full shutdown", async function () {
            const botStarted = Promise.withResolvers<void>();
            runBot = (): Promise<void> => botStarted.promise;
            const application = await setUp();

            const started = application.run();
            const stopped = application.stop();
            botStarted.resolve();
            await Promise.all([started, stopped]);
            await application.stop();

            expect(calls).to.deep.equal(["runner.run", "bot.run", "bot.stop", "taskQueue.isEmpty", "runner.stop", "container.close"]);
        });

        // The failure arrives while the stop is still under way: a rollback into ready would let a
        // repeated stop() start a second one, and the end of the first will set stopped anyway.
        it("stays stopping when the bot fails to start while a stop is in progress", async function () {
            const error = new Error("getMe failed");
            const botStarted = Promise.withResolvers<void>();
            const botStopped = Promise.withResolvers<void>();
            runBot = (): Promise<void> => botStarted.promise;
            stopBot = (): Promise<void> => botStopped.promise;
            const application = await setUp();

            const started = caught(application.run());
            const stopped = application.stop();
            botStarted.reject(error);
            expect(await started).to.equal(error);
            const repeated = application.stop();
            botStopped.resolve();
            await Promise.all([stopped, repeated]);

            expect(calls).to.deep.equal([
                "runner.run",
                "bot.run",
                "bot.stop",
                "runner.stop",
                "taskQueue.isEmpty",
                "runner.stop",
                "container.close",
            ]);
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

        it("stops the bot, waits for the queue, stops the runner and closes the container", async function () {
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(["bot.stop", "taskQueue.isEmpty", "runner.stop", "container.close"]);
            expect(logs).to.deep.equal([
                { level: "info", message: "Stop application...", payload: undefined },
                { level: "info", message: "Application is successfully stopped.", payload: undefined },
            ]);
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
            stopBot = (): Promise<void> => Promise.reject(error);
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
            const botStopped = Promise.withResolvers<void>();
            stopBot = (): Promise<void> => botStopped.promise;
            const application = await start();

            const first = application.stop();
            const second = application.stop().then(() => calls.push("second stop resolved"));
            botStopped.resolve();
            await Promise.all([first, second]);

            expect(calls).to.deep.equal(["bot.stop", "taskQueue.isEmpty", "runner.stop", "container.close", "second stop resolved"]);
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
                "resolve TaskQueue",
                "resolve Runner",
                "resolve Bot",
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
                BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
                TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
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
                BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
                TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
            };
            queueSize = (): number => 0;
            stopBot = (): Promise<void> => new Promise(() => undefined);
            const application = await start();

            await application.stop();

            expect(configUnwatches).to.equal(1);
            expect(logs.filter(({ level }) => level === "warning").map(({ message }) => message)).to.deep.equal([
                "Graceful shutdown timeout is over, the shutdown was cut short.",
            ]);
        });

        it("stops the runner only after the queue has emptied", async function () {
            configValues = { TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "1" };
            const sizes = [2, 1];
            queueSize = (): number => sizes.shift() ?? 0;
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal([
                "bot.stop",
                "taskQueue.isEmpty",
                "taskQueue.isEmpty",
                "taskQueue.isEmpty",
                "runner.stop",
                "container.close",
            ]);
            expect(
                logs.filter(({ message }) => message.startsWith("Waiting for the outgoing queue")).map(({ message }) => message),
            ).to.deep.equal([
                "Waiting for the outgoing queue to empty: 2 tasks left.",
                "Waiting for the outgoing queue to empty: 1 tasks left.",
            ]);
        });

        it("gives up on the queue after its timeout with a warning and still finishes the shutdown", async function () {
            configValues = { TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "20", TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "5" };
            queueSize = (): number => 3;
            const application = await start();

            await application.stop();

            expect(calls[0]).to.equal("bot.stop");
            expect(calls.slice(-2)).to.deep.equal(["runner.stop", "container.close"]);
            expect(logs.filter(({ level }) => level === "warning")).to.deep.equal([
                {
                    level: "warning",
                    message: "Shutdown timeout is over, remaining tasks will not be done.",
                    payload: { tasksLeft: 3, timeout: 20 },
                },
            ]);
        });

        // A zero deadline in docs/architecture/config.md means "do not wait": neither a turn of
        // waiting with a log nor a pause before the runner is stopped. The test catches the mutant
        // `timeLeft < 0` only if both Date.now() in waitQueueToEmpty() landed on the same
        // millisecond: should it change between them, the mutant goes into the warning at once as
        // well. That is why it survives now and then, and there is no hole in the test behind it.
        it("does not wait for the queue when its timeout is zero", async function () {
            configValues = { TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "0" };
            queueSize = (): number => 3;
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(["bot.stop", "taskQueue.isEmpty", "runner.stop", "container.close"]);
            expect(logs).to.deep.equal([
                { level: "info", message: "Stop application...", payload: undefined },
                {
                    level: "warning",
                    message: "Shutdown timeout is over, remaining tasks will not be done.",
                    payload: { tasksLeft: 3, timeout: 0 },
                },
                { level: "info", message: "Application is successfully stopped.", payload: undefined },
            ]);
        });

        // The abandoned step goes on running until process.exit(0) in app.ts cuts it short.
        it("returns with a warning when the shutdown outlives the graceful shutdown timeout", async function () {
            configValues = {
                GRACEFUL_SHUTDOWN_TIMEOUT: "20",
                BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
                TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
            };
            stopBot = (): Promise<void> => new Promise(() => undefined);
            const application = await start();

            await application.stop();

            expect(calls).to.deep.equal(["bot.stop"]);
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
