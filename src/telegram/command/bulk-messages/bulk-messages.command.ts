import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { StringHelper } from "app/shared/string-helper";
import { container } from "app/bootstrap/container/container";
import { Tokens } from "app/shared/tokens";
import { Bot } from "app/telegram/bot";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Context } from "app/telegram/bot.types";
import { Priority } from "app/telegram/outbound-queue/task";
import { FileHelper } from "app/shared/fs/file-helper";
import { Logger } from "app/platform/logger/logger";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly descriptionKey: string = "bulk-messages-command-description";

    public constructor(@inject<Logger>(Tokens.Infrastructure.Logger) private readonly logger: Logger) {
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
        const bot = container.get<Bot>(Tokens.Bot.Bot);
        await FileHelper.createDirectoriesByDate("/home/sardor/applications/telegram-bot/tmp");

        const handler = async (): Promise<void> => {
            await bot.grammy.api.sendMessage(chatId, randomText);
        };

        const taskQueue = container.get<TaskQueue>(Tokens.TaskQueue.TaskQueue);

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
