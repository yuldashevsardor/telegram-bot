import { Command } from "app/infrastructure/bot/command/command";
import { inject, injectable } from "inversify";
import { StringHelper } from "app/helper/string-helper";
import { container } from "app/infrastructure/container/container";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Bot } from "app/infrastructure/bot/bot";
import { TaskQueue } from "app/domain/task-queue/task-queue";
import { Context } from "app/infrastructure/bot/bot.types";
import { Priority } from "app/domain/task-queue/task";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { Logger } from "app/domain/logger/logger";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly descriptionKey: string = "bulk-messages-command-description";

    public constructor(@inject<Logger>(Infrastructure.Logger) private readonly logger: Logger) {
        super();
    }

    protected async handle(_ctx: Context): Promise<void> {
        const promises: Promise<unknown>[] = [];
        const chats = [2815426, 5067823410, 858262157];
        for (let i = 0; i < 100000; i++) {
            for (const chatId of chats) {
                promises.push(this.sendRandomText(chatId));
            }
        }

        await Promise.all(promises);
        this.logger.info("Bulk messages are pushed to the queue.");
    }

    private async sendRandomText(chatId: number): Promise<void> {
        const randomText = StringHelper.generateRandomString(1000);
        const bot = container.get<Bot>(Modules.Bot.Bot);
        await FileHelper.createDirectoriesByDate("/home/sardor/applications/telegram-bot/tmp");

        const handler = async (): Promise<void> => {
            await bot.grammy.api.sendMessage(chatId, randomText);
        };

        const taskQueue = container.get<TaskQueue>(Modules.TaskQueue.TaskQueue);

        taskQueue.push(
            {
                key: chatId,
                callback: handler,
                priorityOnError: Priority.MEDIUM,
            },
            Priority.LOW,
        );
    }
}
