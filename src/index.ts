import * as config from "./config";
import { Context } from "./modules/bot/Context";
import { Telegraf } from "./modules/bot/Telegraf";
import { generateString } from "./utils/utils";

const botToken = config.bot.token;

if (!botToken) {
    throw new Error("Bot token cannot be empty!");
}

const bot = new Telegraf(botToken, {
    contextType: Context,
});

bot.start((context: Context) => {
    for (let i = 0; i < 100; i++) {
        context.reply(generateString(500));
    }
});

bot.launch().catch((error) => {
    console.error(error);
});

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
