import "reflect-metadata";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";

const application = new Application();

async function bootstrap(): Promise<void> {
    await application.setup();
    await application.run();
}

// The only place with a direct console.*, and the decision is taken here rather than at the call
// site: fail() serves both a failure of the configuration (which happens before there is a logger)
// and unhandledRejection with uncaughtException — and those arrive with the context alive, and
// must not lose the level and the requestId.
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
