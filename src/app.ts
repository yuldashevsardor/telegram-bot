import "reflect-metadata";
import { container } from "app/infrastructure/container/container";
import { Application } from "app/infrastructure/application/application";
import { Modules } from "app/infrastructure/container/symbols/modules";

let application: Application | null = null;

async function bootstrap(): Promise<void> {
    await container.setup();
    application = container.get<Application>(Modules.Application);
    await application.run();
}

async function stop(): Promise<void> {
    if (application) {
        await application.stop();
    }

    await container.close();
}

function fail(error: unknown): never {
    console.error(error);
    process.exit(1);
}

async function gracefulStop(): Promise<void> {
    try {
        await stop();
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
