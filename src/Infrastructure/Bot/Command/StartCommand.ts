import { Command } from "App/Infrastructure/Bot/Command/Command";
import { Context } from "App/Infrastructure/Bot/Context";
import { inject, injectable } from "inversify";
import dayjs from "dayjs";
import path from "path";
import { FontConvertor } from "App/Domain/FontConvertor/FontConvertor";
import { Services } from "App/Infrastructure/Container/Symbols/Services";
import { Config } from "App/Infrastructure/Config/Config";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { Extension } from "App/Domain/FontConvertor/Types";
import { StringHelper } from "App/Helper/StringHelper";
import { container } from "App/Infrastructure/Container/Container";
import { Modules } from "App/Infrastructure/Container/Symbols/Modules";
import { Bot } from "App/Infrastructure/Bot/Bot";
import { Planner } from "App/Domain/Planner/Planner";
import { PRIORITY } from "App/Domain/Broker/Message";
import { sleep } from "App/Helper/Utils";

@injectable()
export class StartCommand extends Command {
    public readonly command: string = "start";

    public readonly description: string = "Главное меню / Main menu";

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor,
    ) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        const message = await ctx.reply(`Hello ${ctx.from?.username}`);
        await sleep(10000);
        await ctx.api.editMessageText(message.chat.id, message.message_id, `Bye ${ctx.from?.username}`);

        // setTimeout(() => {
        //     ctx.api.editMessageText(message.chat.id, message.message_id, `By ${ctx.from?.username}`);
        // }, 10000);
    }

    private async generateRandomFonts(ctx: Context): Promise<void> {
        try {
            const start = dayjs();
            const woffPath = path.join(this.config.root, "temp", "test-font.woff");

            const eotPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.EOT,
            });
            await ctx.reply(eotPath);

            const otfPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.OTF,
            });
            await ctx.reply(otfPath);

            const ttfPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.TTF,
            });
            await ctx.reply(ttfPath);

            const woff2Path = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.WOFF2,
            });
            await ctx.reply(woff2Path);
            const diff = dayjs().diff(start, "millisecond");
        } catch (error) {
            console.log(error);
        }
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
            PRIORITY.MEDIUM,
        );
    }
}
