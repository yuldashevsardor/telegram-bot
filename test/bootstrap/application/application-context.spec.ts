import "reflect-metadata";
import { expect } from "chai";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context.errors";
import type { ConfigContainer } from "app/bootstrap/config-container";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { InvalidConfigError } from "app/shared/errors";

type ContextParts = {
    config: ConfigContainer | null;
    logger: Logger | null;
    requestContext: RequestContext | null;
};

// Поля логгера защищённые, а проверить нужно именно их: порог пришёл из конфига, а контекст
// запроса тот же, что отдаёт ApplicationContext, — с чужим корреляция сломалась бы молча.
type LoggerParts = {
    level: Level;
    requestContext: RequestContext;
};

// create() собирает конфиг из окружения процесса, поэтому спека меняет process.env и после
// каждого теста возвращает его и обнуляет поля: контекст общий на весь прогон mocha, и
// заполненным он отдал бы этот конфиг configValue() в чужих спеках.
const context = ApplicationContext as unknown as ContextParts;

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

        context.config = null;
        context.logger = null;
        context.requestContext = null;
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

    it("builds a console logger outside production with the configured level and the request context it hands out", function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "error" });

        ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
        expect(logger).to.be.instanceOf(ConsoleLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.ERROR);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("builds a pino logger in production", function () {
        setEnv({ NODE_ENV: "production", LOGGER_LEVEL: "critical" });

        ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(logger).to.be.instanceOf(PinoLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.CRITICAL);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("keeps the parts on a repeated create() even when the environment has changed", function () {
        setEnv({ NODE_ENV: "development" });
        ApplicationContext.create();

        const config = ApplicationContext.getConfigContainer();
        const logger = ApplicationContext.getLogger();
        const requestContext = ApplicationContext.getRequestContext();

        setEnv({ NODE_ENV: "production" });
        ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer()).to.equal(config);
        expect(ApplicationContext.getLogger()).to.equal(logger);
        expect(ApplicationContext.getRequestContext()).to.equal(requestContext);
    });

    it("stays empty when the config fails, so the next create() starts from scratch", function () {
        setEnv({ NODE_ENV: "prod" });

        expect(() => ApplicationContext.create()).to.throw(InvalidConfigError);
        expect(() => ApplicationContext.getConfigContainer()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getLogger()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getRequestContext()).to.throw(ApplicationContextIsNotCreated);

        setEnv({ NODE_ENV: "production" });
        ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("production");
    });
});
