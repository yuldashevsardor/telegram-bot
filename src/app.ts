import "reflect-metadata";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";

const application = new Application();

async function bootstrap(): Promise<void> {
    await application.setup();
    await application.run();
}

// The only direct console.* in src/ outside the logger adapter, and the decision is taken here
// rather than at the call site: fail() serves both a failure before there is a logger (reading the
// configuration in setup()) and one after it (the rest of the start, unhandledRejection,
// uncaughtException, a failed stop), and the latter must go through the logger to keep the level.
function fail(error: unknown): never {
    try {
        ApplicationContext.getLogger().critical("Fatal error, application is terminated.", { cause: error });
    } catch (loggerError) {
        if (!(loggerError instanceof ApplicationContextIsNotCreated)) {
            // There is a logger, but the write failed: otherwise the reason for the silence would stay unknown.
            // eslint-disable-next-line no-console
            console.error(loggerError);
        }

        // eslint-disable-next-line no-console
        console.error(error);
    }

    process.exit(1);
}

async function gracefulStop(): Promise<void> {
    try {
        await application.stop();
    } catch (error) {
        fail(error);
    }

    process.exit(0);
}

// Enable graceful stop
process.once("SIGINT", () => void gracefulStop());
process.once("SIGTERM", () => void gracefulStop());

process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);

bootstrap().catch(fail);
