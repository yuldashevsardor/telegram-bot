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

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly description: string = "Рассылка / Bulk messages";

    public constructor(@inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        const promises: any[] = [];
        const chats = [2815426, 5067823410, 858262157];
        for (let i = 0; i < 100; i++) {
            for (const chatId of chats) {
                promises.push(new Promise(this.sendRandomText.bind(this, chatId)));
            }
        }

        Promise.all(promises)
            .then((value) => {
                console.log(value);
            })
            .catch((error) => {
                console.log(error);
            });
    }

    private async sendRandomText(chatId: number): Promise<void> {
        const randomText = StringHelper.generateRandomString(100);
        const bot = container.get<Bot>(Modules.Bot.Bot);

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
