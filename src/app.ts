import "reflect-metadata";
import { container } from "app/infrastructure/container/container";
import { Bot } from "app/infrastructure/bot/bot";
import { Modules } from "app/infrastructure/container/symbols/modules";

let bot: Bot | null = null;

async function bootstrap(): Promise<void> {
    await container.setup();
    bot = container.get<Bot>(Modules.Bot.Bot);
    await bot.run();
}

async function stop(): Promise<void> {
    if (bot) {
        await bot.stop();
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
