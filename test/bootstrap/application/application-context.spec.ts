import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { InvalidConfigError } from "app/shared/errors";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import type { UnknownObject } from "app/shared/types";
import { resetApplicationContext } from "test/bootstrap/application/application-context.helper";

// Поля логгера защищённые, а проверить нужно именно их: порог пришёл из конфига, а контекст
// запроса тот же, что отдаёт ApplicationContext, — с чужим корреляция сломалась бы молча.
type LoggerParts = {
    level: Level;
    requestContext: RequestContext;
};

// Правку файла конфигурация подхватывает опросом, поэтому спека ждёт не промис, а появление
// результата.
async function waitFor(done: () => boolean, reason: string, timeout = 2000): Promise<void> {
    const deadline = Date.now() + timeout;

    while (!done()) {
        if (Date.now() > deadline) {
            expect.fail(reason);
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// Правка наблюдаемого файла идёт одним шагом — готовое содержимое переименовывается поверх пути.
// fs.writeFile с флагом по умолчанию сначала обрезает файл (O_TRUNC) и только потом пишет
// содержимое, поэтому опрос, попавший между обрезкой и записью, видит два изменения вместо одного,
// и конфигурация пересобирается лишний раз — по пустому файлу. Так же файл и появляется:
// наблюдение заводит create(), то есть до первой записи. Записи до create() под наблюдение не
// попадают и идут обычным fs.writeFile.
async function replace(target: string, contents: string): Promise<void> {
    const temporary = `${target}.tmp`;

    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, target);
}

// create() собирает конфиг из окружения процесса, поэтому спека меняет process.env и после
// каждого теста возвращает его и сбрасывает контекст.
describe("ApplicationContext", function () {
    const originalEnv = new Map<string, string | undefined>();

    function unsetEnv(key: string): void {
        if (!originalEnv.has(key)) {
            originalEnv.set(key, process.env[key]);
        }

        delete process.env[key];
    }

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
        filePath = path.join(directory, ".runtime.env");

        // Опрос по умолчанию редкий: до конца теста он не сработает ни разу, а тесты, которым
        // наблюдение нужно, задают свой интервал. Совсем выключить его нечем — минимум задан
        // конфигурацией, — поэтому каждый тест гасит источник в afterEach: у mocha нет --exit.
        setEnv({ BOT_TOKEN: "test-token", CONFIG_FILE_PATH: filePath, CONFIG_FILE_WATCH_INTERVAL: "100000" });
    });

    // Один хук, а не два: наблюдение обязано умереть раньше своего каталога, иначе опрос успевает
    // застать исчезновение файла и пересобрать конфигурацию уже закончившегося теста — с вызовом
    // слушателей и записью в лог.
    afterEach(async function () {
        resetApplicationContext();

        for (const [key, value] of originalEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }

        originalEnv.clear();

        await fs.rm(directory, { recursive: true, force: true });
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

    // Сборка асинхронная: проверка готовых частей пропустила бы оба вызова, и второй собрал бы
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

    // Заданная переменная окружения сильнее файла, а пустая уступает ему: менять на ходу можно
    // то, чего в окружении нет.
    it("builds the config with the environment winning over the file", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "debug" });
        await fs.writeFile(filePath, "LOGGER_LEVEL=error\n");

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.DEBUG);

        resetApplicationContext();
        setEnv({ LOGGER_LEVEL: "" });

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Наблюдение включает сам контекст: без него правка файла осталась бы незамеченной до
    // перезапуска, и подписки не значили бы ничего.
    it("watches the file it was pointed at, so a change reaches the config by itself", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_WATCH_INTERVAL: "100" });

        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();
        const levels: Level[] = [];

        cc.onChange("logger.level", (newValue) => {
            levels.push(newValue);
        });

        await replace(filePath, "LOGGER_LEVEL=error\n");
        // Срок короткий намеренно: с интервалом по умолчанию (2000 мс) правка за него не
        // доехала бы, то есть тест держит и сам интервал, а не только факт наблюдения.
        await waitFor(() => levels.length > 0, "the change of the file did not reach the config", 1500);

        expect(levels).to.deep.equal([Level.ERROR]);
        expect(cc.get("logger.level")).to.equal(Level.ERROR);
    });

    // Путь по умолчанию — <корень приложения>/.runtime.env, и в контейнере туда смонтирован
    // одноимённый файл с хоста; ошибка в нём означала бы, что приложение следит не за тем файлом.
    it("falls back to .runtime.env in the working directory", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "" });
        unsetEnv("CONFIG_FILE_PATH");
        unsetEnv("CONFIG_FILE_WATCH_INTERVAL");

        await fs.writeFile(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=error\n");

        const cwd = process.cwd();

        process.chdir(directory);

        try {
            await ApplicationContext.create();
        } finally {
            process.chdir(cwd);
        }

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Наблюдение заводит init() контейнера, то есть до того, как контекст заполнен: упади сборка
    // между ними, опрос остался бы работать, а дотянуться до него было бы нечем — ссылки на
    // контейнер нигде нет.
    it("unwatches the config file when the rest of the context fails to assemble", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "100" });

        const failure = new Error("logger is broken");
        const parts = ApplicationContext as unknown as { createLogger: () => never };
        const originalCreateLogger = parts.createLogger;
        const originalUnwatch = ConfigFileStorage.prototype.unwatch;
        let unwatches = 0;

        parts.createLogger = (): never => {
            throw failure;
        };
        ConfigFileStorage.prototype.unwatch = function unwatch(this: ConfigFileStorage): void {
            unwatches += 1;

            originalUnwatch.call(this);
        };

        try {
            const error = await ApplicationContext.create().then(
                () => expect.fail("create() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.equal(failure);
            expect(unwatches).to.equal(1);
        } finally {
            parts.createLogger = originalCreateLogger;
            ConfigFileStorage.prototype.unwatch = originalUnwatch;
        }
    });

    // Отказ пересборки не валит процесс: приложение остаётся на прежних значениях, а причина
    // уходит в лог — логгера у самой конфигурации нет, она собирается раньше него.
    it("logs a failed reload and keeps the previous values", async function () {
        this.timeout(6000);

        // NODE_ENV снимается с окружения: заданная переменная сильнее файла, и подсунуть в файл
        // недопустимое значение поверх неё нельзя.
        setEnv({ CONFIG_FILE_WATCH_INTERVAL: "100" });
        unsetEnv("NODE_ENV");
        await ApplicationContext.create();

        const records: Array<{ message: string; payload: UnknownObject | undefined }> = [];
        const logger = ApplicationContext.getLogger();

        logger.error = (message: string, payload?: UnknownObject): void => {
            records.push({ message: message, payload: payload });
        };

        await replace(filePath, "NODE_ENV=prod\n");
        await waitFor(() => records.length > 0, "the failed reload did not reach the log", 4000);

        expect(records[0]?.message).to.equal("Config reload failed, the previous values are kept.");
        expect(records[0]?.payload?.["cause"]).to.be.instanceOf(InvalidConfigError);
        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    it("fails the start on an interval that is not a whole number of milliseconds", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "half a second" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error)
            .to.be.instanceOf(InvalidConfigError)
            .with.property("message", 'Config value "CONFIG_FILE_WATCH_INTERVAL" must be an integer');
    });

    // Огромный интервал таймер Node превращает в 1 мс, то есть «раз в сутки» стало бы опросом на
    // каждом витке цикла; отрицательный — тем же самым.
    it("fails the start on an interval a timer cannot hold", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "2147483648" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InvalidConfigError);

        setEnv({ CONFIG_FILE_WATCH_INTERVAL: "-1" });

        const negative = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(negative).to.be.instanceOf(InvalidConfigError);
    });

    // Пустая переменная и пробелы вокруг значения — то же, что её отсутствие: иначе путь с
    // пробелом на конце уводил бы наблюдение на файл, которого нет, а интервал не разобрался бы
    // вовсе.
    it("treats a blank path and a padded value as if they were not set", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_PATH: "   ", CONFIG_FILE_WATCH_INTERVAL: "  100  " });

        await fs.writeFile(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=error\n");

        const cwd = process.cwd();

        process.chdir(directory);

        try {
            await ApplicationContext.create();
        } finally {
            process.chdir(cwd);
        }

        const cc = ApplicationContext.getConfigContainer();

        expect(cc.get("logger.level")).to.equal(Level.ERROR);

        // Интервал разобран как 100 мс, а не отброшен: правка доезжает задолго до умолчания.
        await replace(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=warning\n");
        await waitFor(() => cc.get("logger.level") === Level.WARNING, "the padded interval was not applied", 1500);
    });

    // Верхнюю границу интервала приложение принимает: это наибольшая задержка, которую держит
    // таймер Node, и на ней наблюдение ещё законно.
    it("accepts the longest interval a timer can hold", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "2147483647" });

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    // Пробельное значение — то же, что отсутствие: без обрезки оно стало бы нулём, то есть молча
    // выключило бы наблюдение. Отсюда и срок теста: он должен покрывать интервал по умолчанию.
    it("watches with the default interval when the variable holds only spaces", async function () {
        this.timeout(8000);

        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_WATCH_INTERVAL: "   " });
        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();

        await replace(filePath, "LOGGER_LEVEL=error\n");
        await waitFor(
            () => cc.get("logger.level") === Level.ERROR,
            "the change of the file did not reach the config within the default interval",
            5000,
        );
    });

    // Ниже сотни опрос не опускается: конфигурацию не правят чаще, а stat на каждый виток
    // цикла не бесплатен.
    it("fails the start on an interval below the minimum", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "50" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error)
            .to.be.instanceOf(InvalidConfigError)
            .with.property("message", 'Config value "CONFIG_FILE_WATCH_INTERVAL" must be between 100 and 2147483647');
    });
});
