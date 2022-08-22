import "reflect-metadata";
import { container } from "App/Infrastructure/Config/Dependency/Container";
import { Bot } from "App/Infrastructure/Bot/Bot";
import { Modules } from "App/Infrastructure/Config/Dependency/Symbols/Modules";

let bot: Bot | null = null;

async function bootstrap(): Promise<void> {
    await container.load();
    bot = container.get<Bot>(Modules.Bot.Bot);
    await bot.run();
}

async function stop(): Promise<void> {
    if (bot) {
        await bot.stop();
    }

    await container.close();
}

// Enable graceful stop
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

bootstrap().catch(console.error);
