import { Command } from "App/Modules/Bot/Command/Command";
import { Context } from "App/Modules/Bot/Context";
import { inject, injectable } from "inversify";
import dayjs from "dayjs";
import path from "path";
import { FontConvertor } from "App/Services/FontConvertor/FontConvertor";
import { Services } from "App/Config/Dependency/Symbols/Services";
import { Config } from "App/Config/Config";
import { Infrastructure } from "App/Config/Dependency/Symbols/Infrastructure";
import { Extension } from "App/Services/FontConvertor/Types";
import { StringHelper } from "App/Helpers/StringHelper";
import { container } from "App/Config/Dependency/Container";
import { Modules } from "App/Config/Dependency/Symbols/Modules";
import { Bot } from "App/Modules/Bot/Bot";
import { Planner } from "App/Modules/Planner/Planner";
import { PRIORITY } from "App/Modules/Broker/Message";

@injectable()
export class StartCommand extends Command {
    protected readonly command: string = "start";

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor,
    ) {
        super();
    }

    protected async handler(ctx: Context): Promise<void> {
        const promises: any[] = [];
        const chats = [2815426, 5067823410, 858262157];
        for (let i = 0; i < 1000; i++) {
            for (const chatId of chats) {
                // promises.push(new Promise(this.generateRandomFonts.bind(this, ctx)));
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
            await bot.bot.api.sendMessage(chatId, randomText);
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
