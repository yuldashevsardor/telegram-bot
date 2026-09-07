import "reflect-metadata";
import { Application } from "app/infrastructure/application/application";

const application = new Application();

async function bootstrap(): Promise<void> {
    await application.setup();
    await application.run();
}

function fail(error: unknown): never {
    console.error(error);
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
