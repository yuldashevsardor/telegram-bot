import path from "path";
import { ConfigContainer } from "app/bootstrap/config/container/config-container";
import type { CC } from "app/bootstrap/config/container/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigParser } from "app/bootstrap/config/parser/config-parser";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";

type Parts = {
    cc: CC;
    logger: Logger;
    requestContext: RequestContext;
};

// What the container cannot be assembled without. Why the list stays short and the class is fully
// static: docs/architecture/application.md, "Application".
export class ApplicationContext {
    // The polling of the watched file, ms. Kept here rather than in ConfigValuesBuilder: both
    // variables of the file are needed before the assembled configuration.
    private static readonly DEFAULT_WATCH_INTERVAL = 2000;
    private static readonly MIN_WATCH_INTERVAL = 100;
    private static readonly DEFAULT_CONFIG_FILE = ".runtime.env";

    // One value rather than a field per part: create() and the getters decide readiness by one check,
    // and the type allows no half-assembled context.
    private static parts: Parts | null = null;
    private static creating: Promise<void> | null = null;

    // One context per process, so a repeated create() is the same assembly: a call in the middle of
    // it waits for it. The config is assembled asynchronously, and a check of the ready parts alone
    // would let both calls through. The promise is dropped whatever the outcome, so the parts stay
    // the only sign of readiness. Why: docs/architecture/application.md, "Application".
    public static create(): Promise<void> {
        if (ApplicationContext.parts !== null) {
            return Promise.resolve();
        }

        if (ApplicationContext.creating === null) {
            ApplicationContext.creating = ApplicationContext.assemble().finally(() => {
                ApplicationContext.creating = null;
            });
        }

        return ApplicationContext.creating;
    }

    public static getConfigContainer(): CC {
        return ApplicationContext.getParts().cc;
    }

    public static getLogger(): Logger {
        return ApplicationContext.getParts().logger;
    }

    public static getRequestContext(): RequestContext {
        return ApplicationContext.getParts().requestContext;
    }

    private static getParts(): Parts {
        if (ApplicationContext.parts === null) {
            throw new ApplicationContextIsNotCreated("ApplicationContext is not created, call create() first.");
        }

        return ApplicationContext.parts;
    }

    // The config before the logger: the adapter and the threshold both come from it. So a
    // configuration error comes before the logger, and fail() prints it through console.error.
    private static async assemble(): Promise<void> {
        const cc = new ConfigContainer<ConfigValues>(ApplicationContext.createStorage(), new ConfigValuesBuilder());
        await cc.init();

        // init() has switched watching on, and fill() can still fail. Then no reference to the
        // container is left anywhere, the stop of the application cannot reach it, and the poll
        // would stay running.
        try {
            ApplicationContext.fill(cc);
        } catch (error) {
            cc.unwatch();

            throw error;
        }
    }

    private static fill(cc: CC): void {
        const requestContext = new RequestContext();
        const logger = ApplicationContext.createLogger(cc, requestContext);

        ApplicationContext.parts = { cc: cc, logger: logger, requestContext: requestContext };

        // The configuration has no logger of its own: it is assembled before one. Watching is on
        // already, but no rebuild can fail unheard before this subscription
        // (docs/architecture/application.md, "Application"). Application.terminate() switches
        // watching off.
        cc.onError((error: unknown): void => {
            logger.error("Config reload failed, the previous values are kept.", { cause: error });
        });
    }

    // The path and the polling interval are read from process.env before the configuration exists
    // (docs/architecture/config.md, "Watching the file"). Not from .env: ConfigEnvStorage.load()
    // calls dotenv.config() later, inside init(). Under Compose the two are the same (env_file), and
    // outside it both are set as variables of the process.
    private static createStorage(): ConfigStorage {
        const parser = new ConfigParser({ ...process.env });

        return new ConfigFileStorage(
            new ConfigEnvStorage(),
            parser.getString("CONFIG_FILE_PATH", path.join(process.cwd(), ApplicationContext.DEFAULT_CONFIG_FILE)),
            // Why the lower bound is 100 ms and a value not allowed fails the start:
            // docs/architecture/config.md, "Watching the file".
            parser.getTimerDelay("CONFIG_FILE_WATCH_INTERVAL", ApplicationContext.DEFAULT_WATCH_INTERVAL, {
                min: ApplicationContext.MIN_WATCH_INTERVAL,
            }),
        );
    }

    // There is one logger per process: it takes the values of the request from RequestContext at the
    // moment of the write, so there is no need to swap the object itself per request.
    private static createLogger(cc: CC, requestContext: RequestContext): Logger {
        const logger = cc.get("isProduction") ? new PinoLogger(requestContext) : new ConsoleLogger(requestContext);
        logger.setLevel(cc.get("logger.level"));

        return logger;
    }
}
