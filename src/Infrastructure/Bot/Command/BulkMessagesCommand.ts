import { Command } from "App/Infrastructure/Bot/Command/Command";
import { inject, injectable } from "inversify";
import { FontConvertor } from "App/Domain/FontConvertor/FontConvertor";
import { Services } from "App/Infrastructure/Container/Symbols/Services";
import { StringHelper } from "App/Helper/StringHelper";
import { container } from "App/Infrastructure/Container/Container";
import { Modules } from "App/Infrastructure/Container/Symbols/Modules";
import { Bot } from "App/Infrastructure/Bot/Bot";
import { Planner } from "App/Domain/Planner/Planner";
import { PRIORITY } from "App/Domain/Broker/Message";
import { Context } from "App/Infrastructure/Bot/Types";

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
