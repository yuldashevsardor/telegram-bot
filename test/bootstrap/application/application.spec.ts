import "reflect-metadata";
import { expect } from "chai";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ConfigContainer } from "app/bootstrap/config-container";
import { container } from "app/bootstrap/container/container";
import type { ConfigStorage } from "app/platform/config/config-storage";
import type { Database } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { RuntimeError } from "app/shared/errors";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import type { Bot } from "app/telegram/bot";
import type { Runner } from "app/telegram/outbound-queue/runner";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";

type ContextParts = {
    config: ConfigContainer | null;
    logger: Logger | null;
};

type Log = {
    level: keyof Logger;
    message: string;
    payload: UnknownObject | undefined;
};

class FakeStorage implements ConfigStorage {
    public constructor(private readonly values: Record<string, string>) {}

    public get(key: string): string | undefined {
        return this.values[key];
    }
}

const context = ApplicationContext as unknown as ContextParts;

describe("Application", function () {
    // Порядок старта и остановки — то, что спека закрепляет, поэтому все подмены пишут свои
    // вызовы в один общий список.
    const calls: string[] = [];
    const logs: Log[] = [];

    let configValues: Record<string, string>;
    let checkDatabase: () => Promise<void>;
    let runBot: () => Promise<void>;
    let stopBot: () => Promise<void>;
    let queueSize: () => number;
    let lastQueueSize = 0;

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

    // Application берёт контекст и глобальный container, а не зависимости через конструктор,
    // поэтому подменяются они. Настоящий create() собрал бы конфиг из окружения процесса.
    // Настоящий setup() связал бы под теми же символами настоящие классы, и резолв упал бы
    // «Ambiguous match», а настоящий close() закрывал бы пул Database. Всё возвращается после
    // спеки: контекст и контейнер общие на весь прогон mocha.
    const originalCreate = ApplicationContext.create.bind(ApplicationContext);
    const originalSetup = container.setup.bind(container);
    const originalClose = container.close.bind(container);

    before(function () {
        ApplicationContext.create = (): void => {
            calls.push("context.create");
            context.config = new ConfigContainer(new FakeStorage(configValues));
            context.logger = logger;
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
        context.config = null;
        context.logger = null;
    });

    // Вызовы на пути к нужному состоянию сбрасываются: их закрепляют тесты setup() и run().
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

        // Отказ логирует только fail() в app.ts: второй critical на тот же отказ удвоил бы
        // счётчик алертов.
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

        // Сегодня окна между runner.run() и концом bot.run() нет: в Bot.run() нет await. Этот тест
        // и следующий держат поведение на случай, если await там появится.
        it("counts as running while the bot is starting, so a stop in between stops the bot too", async function () {
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

        it("stays stopping when the bot fails to start after a stop has begun", async function () {
            const error = new Error("getMe failed");
            const botStarted = Promise.withResolvers<void>();
            runBot = (): Promise<void> => botStarted.promise;
            const application = await setUp();

            const started = caught(application.run());
            const stopped = application.stop();
            botStarted.reject(error);
            expect(await started).to.equal(error);
            await stopped;
            calls.length = 0;

            await application.run();

            expect(calls).to.deep.equal([]);
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

        // Так app.ts обрабатывает сигнал другого вида, пришедший во время остановки: второй
        // stop(), вернувшийся раньше первого, дал бы process.exit(0) оборвать остановку.
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

        // Сигнал посреди setup(): bootstrap() в app.ts после настройки зовёт run(), и тот не
        // должен запустить приложение, которое уже останавливается.
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

        // Отказ приходит в fail() из обоих путей app.ts с одной ошибкой; первый вызов завершает
        // процесс, поэтому critical один, а код выхода — 1, а не exit(0) остановки.
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

        // Нулевой срок в docs/architecture/config.md — «не ждать»: ни витка ожидания с логом, ни паузы
        // перед остановкой runner. Мутанта `timeLeft < 0` тест ловит, только если оба Date.now() в
        // waitQueueToEmpty() пришлись на одну миллисекунду: сменись она между ними — и мутант тоже сразу
        // уходит в предупреждение. Поэтому изредка он выживает, и дыры в тесте за этим нет.
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

        // Брошенный шаг продолжает выполняться, пока его не оборвёт process.exit(0) в app.ts.
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
