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

// What the application always needs: these objects exist before the container, because it cannot
// be assembled without them. The list is deliberately short and is kept that way: the context is
// known only to Application and Container.setup(), while the consumers get its parts from the
// container — otherwise the context itself would start being injected, and it would become a
// second DI.
//
// The class is static through and through: the parts lie on it rather than in an instance that
// whoever called create() must not lose. A lost reference to an object would be impossible to
// recover — the assembled logger and storage would stay in the process with no entrance to them.
export class ApplicationContext {
    // The polling of the watched file, ms. Kept here rather than in ConfigValuesBuilder: both
    // variables of the file are needed before the assembled configuration.
    private static readonly DEFAULT_WATCH_INTERVAL = 2000;
    private static readonly MIN_WATCH_INTERVAL = 100;
    private static readonly DEFAULT_CONFIG_FILE = ".runtime.env";

    // One value rather than a field per part: whether the context is assembled is decided by
    // create() and by the getters with one check, and a half-assembled context is not allowed by the
    // type.
    private static parts: Parts | null = null;
    private static creating: Promise<void> | null = null;

    // There is one context per process: a second one would break correlation silently — it would
    // have a request storage of its own, and the logger would read a store other than the one the
    // middleware opened. That is why a repeated create() is not an error but the same assembly: a
    // call in the middle of it waits for that one instead of starting a second — the config is
    // assembled asynchronously, and a single check of the ready parts would let both calls through.
    //
    // The promise lives only while the assembly is under way and is forgotten whatever the outcome:
    // an assembly that failed does not stop the next create() from starting from scratch, and
    // whether the context is assembled create() decides by the same parts the getters use. Were the
    // promise to be kept after the assembly as well, there would be two signs of readiness, and a
    // context that has been reset (that is how the specs reset it) would be neither reassembled by
    // create() nor served by the getters.
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

    // The config before the logger: the adapter and the threshold both come from it. So an error of
    // the configuration happens before there is a logger, and it is printed by fail() through its
    // console.error fallback.
    private static async assemble(): Promise<void> {
        const cc = new ConfigContainer<ConfigValues>(ApplicationContext.createStorage(), new ConfigValuesBuilder());
        await cc.init();

        // Watching was switched on by init(), while the context is filled below: were the assembly
        // to fail between them, the poll would stay running and become unreachable — there is no
        // reference to the container anywhere, and the stop of the application would not get to it.
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

        // A failed rebuild is written by the logger: the configuration itself has no logger, it is
        // assembled before one. Watching was switched on by init() already, but that opens no window
        // without an addressee: from here up to the subscription the code is synchronous, and the
        // callback of the watcher waits for its task in the queue. Watching is switched off by the
        // stop of the application (`Application.terminate()`): a poll left behind would rebuild the
        // configuration of an application that is already closing.
        cc.onError((error: unknown): void => {
            logger.error("Config reload failed, the previous values are kept.", { cause: error });
        });
    }

    // The path of the file and the interval of its polling are needed before the assembled
    // configuration, so they are read from the environment: the snapshot for ConfigParser is
    // process.env itself. The environment and not .env: dotenv.config() is called by
    // ConfigEnvStorage.load() inside init(), that is later. In the supported way of running they are
    // the same thing — the variables from .env are put into the environment by Compose (env_file) —
    // and outside it both are set as variables of the process.
    private static createStorage(): ConfigStorage {
        const parser = new ConfigParser({ ...process.env });

        return new ConfigFileStorage(
            new ConfigEnvStorage(),
            parser.getString("CONFIG_FILE_PATH", path.join(process.cwd(), ApplicationContext.DEFAULT_CONFIG_FILE)),
            // The lower bound is not one: polling is cheap but not free (a stat on every turn), and
            // configuration is not edited more often than once a tenth of a second. A value that is
            // not allowed fails the start instead of turning into the default — polling silently sped
            // up looks like polling that works.
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
