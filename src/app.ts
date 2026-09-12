import "reflect-metadata";
import { Application } from "app/bootstrap/application/application";
import { ApplicationContext } from "app/bootstrap/application/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/application-context.errors";

const application = new Application();

async function bootstrap(): Promise<void> {
    await application.setup();
    await application.run();
}

// Единственное место с прямым console.*, и решение принимается здесь, а не по вызову:
// fail() обслуживает и падение конфигурации (оно случается до появления логгера), и
// unhandledRejection с uncaughtException — а те приходят уже при живом контексте, и
// уровня с requestId лишаться не должны.
function fail(error: unknown): never {
    try {
        ApplicationContext.getLogger().critical("Fatal error, application is terminated.", { cause: error });
    } catch (loggerError) {
        if (!(loggerError instanceof ApplicationContextIsNotCreated)) {
            // Логгер есть, но запись не удалась: иначе причина молчания осталась бы неизвестной.
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
