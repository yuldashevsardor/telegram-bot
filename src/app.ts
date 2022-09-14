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

// Enable graceful stop
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

bootstrap().catch(console.error);
