import { Bot } from "./modules/bot/Bot";

const bot = new Bot();

bot.run();

// Enable graceful stop
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
