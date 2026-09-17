import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context.errors";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { InvalidConfigError } from "app/shared/errors";
import type { UnknownObject } from "app/shared/types";
import { resetApplicationContext } from "test/bootstrap/application/application-context.helper";

// Поля логгера защищённые, а проверить нужно именно их: порог пришёл из конфига, а контекст
// запроса тот же, что отдаёт ApplicationContext, — с чужим корреляция сломалась бы молча.
type LoggerParts = {
    level: Level;
    requestContext: RequestContext;
};

// create() собирает конфиг из окружения процесса, поэтому спека меняет process.env и после
// каждого теста возвращает его и сбрасывает контекст.
describe("ApplicationContext", function () {
    const originalEnv = new Map<string, string | undefined>();

    function setEnv(values: Record<string, string>): void {
        for (const [key, value] of Object.entries(values)) {
            if (!originalEnv.has(key)) {
                originalEnv.set(key, process.env[key]);
            }

            process.env[key] = value;
        }
    }

    // Настоящий create() заводит наблюдение за файлом конфигурации, поэтому спека держит свой
    // каталог: файла в рабочем каталоге прогона может не быть вовсе, а чужой подменять нельзя.
    let directory: string;
    let filePath: string;

    // Конфиг требует BOT_TOKEN, а окружение прогона держать настоящий токен не обязано.
    beforeEach(async function () {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "application-context-"));
        filePath = path.join(directory, "runtime.env");

        // Опрос выключен: спеки пересобирают конфигурацию вызовом reload(), а не правкой файла,
        // и оставленный опрос держал бы прогон — у mocha нет --exit.
        setEnv({ BOT_TOKEN: "test-token", CONFIG_FILE_PATH: filePath, CONFIG_FILE_WATCH_INTERVAL: "0" });
    });

    afterEach(async function () {
        await fs.rm(directory, { recursive: true, force: true });
    });

    afterEach(function () {
        for (const [key, value] of originalEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }

        originalEnv.clear();
        resetApplicationContext();
    });

    it("throws ApplicationContextIsNotCreated from every getter before create()", function () {
        const message = "ApplicationContext is not created, call create() first.";

        expect(() => ApplicationContext.getConfigContainer())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
        expect(() => ApplicationContext.getLogger())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
        expect(() => ApplicationContext.getRequestContext())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
    });

    it("builds a console logger outside production with the configured level and the request context it hands out", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "error" });

        await ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
        expect(logger).to.be.instanceOf(ConsoleLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.ERROR);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("builds a pino logger in production", async function () {
        setEnv({ NODE_ENV: "production", LOGGER_LEVEL: "critical" });

        await ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(logger).to.be.instanceOf(PinoLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.CRITICAL);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("keeps the parts on a repeated create() even when the environment has changed", async function () {
        setEnv({ NODE_ENV: "development" });
        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();
        const logger = ApplicationContext.getLogger();
        const requestContext = ApplicationContext.getRequestContext();

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer()).to.equal(cc);
        expect(ApplicationContext.getLogger()).to.equal(logger);
        expect(ApplicationContext.getRequestContext()).to.equal(requestContext);
    });

    // Сборка асинхронная: проверка готовых полей пропустила бы оба вызова, и второй собрал бы
    // второй контекст поверх первого.
    it("waits for the create() in progress instead of starting another one", async function () {
        setEnv({ NODE_ENV: "development" });
        const first = ApplicationContext.create();

        setEnv({ NODE_ENV: "production" });
        const second = ApplicationContext.create();
        await Promise.all([first, second]);

        expect(second).to.equal(first);
        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    it("builds the context again once its parts have been reset", async function () {
        setEnv({ NODE_ENV: "development" });
        await ApplicationContext.create();
        resetApplicationContext();

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("production");
    });

    it("stays empty when the config fails, so the next create() starts from scratch", async function () {
        setEnv({ NODE_ENV: "prod" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InvalidConfigError);
        expect(() => ApplicationContext.getConfigContainer()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getLogger()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getRequestContext()).to.throw(ApplicationContextIsNotCreated);

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("production");
    });

    // Значения файла ложатся поверх окружения: иначе поменять на ходу то, что задано переменной,
    // было бы нечем.
    it("builds the config with the file values laid over the environment", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "debug" });
        await fs.writeFile(filePath, "LOGGER_LEVEL=error\n");

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Наблюдение включает сам контекст: без него правка файла осталась бы незамеченной до
    // перезапуска, и подписки не значили бы ничего.
    it("watches the file it was pointed at, so a change reaches the config by itself", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "debug", CONFIG_FILE_WATCH_INTERVAL: "5" });

        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();
        const levels: Level[] = [];

        cc.onChange("logger.level", (newValue) => {
            levels.push(newValue);
        });

        await fs.writeFile(filePath, "LOGGER_LEVEL=error\n");

        // Срок короткий намеренно: с интервалом по умолчанию (2000 мс) правка за него не
        // доехала бы, то есть тест держит и сам интервал, а не только факт наблюдения.
        const deadline = Date.now() + 500;

        while (levels.length === 0) {
            if (Date.now() > deadline) {
                expect.fail("the change of the file did not reach the config");
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        expect(levels).to.deep.equal([Level.ERROR]);
        expect(cc.get("logger.level")).to.equal(Level.ERROR);
    });

    // Путь по умолчанию — <корень приложения>/config/runtime.env, и в контейнере туда смонтирован
    // каталог config; ошибка в нём означала бы, что приложение следит не за тем файлом.
    it("falls back to config/runtime.env in the working directory", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "debug", CONFIG_FILE_PATH: "" });

        await fs.mkdir(path.join(directory, "config"));
        await fs.writeFile(path.join(directory, "config", "runtime.env"), "LOGGER_LEVEL=error\n");

        const cwd = process.cwd();

        process.chdir(directory);

        try {
            await ApplicationContext.create();
        } finally {
            process.chdir(cwd);
        }

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Отказ пересборки не валит процесс: приложение остаётся на прежних значениях, а причина
    // уходит в лог — логгера у самой конфигурации нет, она собирается раньше него.
    it("logs a failed reload and keeps the previous values", async function () {
        setEnv({ NODE_ENV: "development" });
        await ApplicationContext.create();

        const records: Array<{ message: string; payload: UnknownObject | undefined }> = [];
        const logger = ApplicationContext.getLogger();

        logger.error = (message: string, payload?: UnknownObject): void => {
            records.push({ message: message, payload: payload });
        };

        await fs.writeFile(filePath, "NODE_ENV=prod\n");
        await ApplicationContext.getConfigContainer().reload();

        expect(records).to.have.lengthOf(1);
        expect(records[0]?.message).to.equal("Config reload failed, the previous values are kept.");
        expect(records[0]?.payload?.["cause"]).to.be.instanceOf(InvalidConfigError);
        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });
});
