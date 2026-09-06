import { Command } from "app/infrastructure/bot/command/command";
import { injectable } from "inversify";
import { StringHelper } from "app/helper/string-helper";
import { container } from "app/infrastructure/container/container";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Bot } from "app/infrastructure/bot/bot";
import { Dispatcher } from "app/domain/dispatcher/dispatcher";
import { Context } from "app/infrastructure/bot/bot.types";
import { PRIORITY } from "app/domain/dispatcher/task";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { Config } from "app/infrastructure/config/config";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly description: string = "Рассылка / Bulk messages";

    protected async handle(_ctx: Context): Promise<void> {
        const promises: Promise<unknown>[] = [];
        const chats = [2815426, 5067823410, 858262157];
        for (let i = 0; i < 100000; i++) {
            for (const chatId of chats) {
                promises.push(this.sendRandomText(chatId));
            }
        }

        await Promise.all(promises);
        console.log("done");
    }

    private async sendRandomText(chatId: number): Promise<void> {
        const randomText = StringHelper.generateRandomString(1000);
        const bot = container.get<Bot>(Modules.Bot.Bot);
        await FileHelper.createDirectoriesByDate("/home/sardor/applications/telegram-bot/tmp");

        const handler = async (): Promise<void> => {
            await bot.grammy.api.sendMessage(chatId, randomText);
        };

        const dispatcher = container.get<Dispatcher>(Modules.Dispatcher.Dispatcher);
        const config = container.get<Config>(Infrastructure.Config);

        dispatcher.push(
            {
                key: chatId,
                rate: config.rates.private,
                callback: handler,
                priorityOnError: PRIORITY.MEDIUM,
            },
            PRIORITY.LOW,
        );
    }
}
