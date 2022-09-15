import { Command } from "app/infrastructure/bot/command/command";
import { inject, injectable } from "inversify";
import { FontConvertor } from "app/domain/font-convertor/font-convertor";
import { Services } from "app/infrastructure/container/symbols/services";
import { StringHelper } from "app/helper/string-helper";
import { container } from "app/infrastructure/container/container";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Bot } from "app/infrastructure/bot/bot";
import { Planner } from "app/domain/planner/planner";
import { Context } from "app/infrastructure/bot/bot.types";
import { PRIORITY } from "app/domain/broker/broker.types";
import { FileHelper } from "app/helper/file-helper/file-helper";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly description: string = "Рассылка / Bulk messages";

    public constructor(@inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
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

        const planner = container.get<Planner>(Modules.Planner.Planner);

        planner.push(
            {
                chatId: chatId,
                isGroup: false,
                callback: handler,
                priorityOnError: PRIORITY.MEDIUM,
            },
            PRIORITY.LOW,
        );
    }
}
