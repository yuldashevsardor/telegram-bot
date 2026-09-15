import "reflect-metadata";
import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context.errors";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { InvalidConfigError } from "app/shared/errors";
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

    // Конфиг требует BOT_TOKEN, а окружение прогона держать настоящий токен не обязано.
    beforeEach(function () {
        setEnv({ BOT_TOKEN: "test-token" });
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
});
