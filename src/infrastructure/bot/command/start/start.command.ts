import { Command } from "app/infrastructure/bot/command/command";
import { inject, injectable } from "inversify";
import dayjs from "dayjs";
import path from "path";
import { FontConvertor } from "app/domain/font-convertor/font-convertor";
import { Services } from "app/infrastructure/container/symbols/services";
import { Config } from "app/infrastructure/config/config";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { StringHelper } from "app/helper/string-helper";
import { container } from "app/infrastructure/container/container";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Bot } from "app/infrastructure/bot/bot";
import { Planner } from "app/domain/planner/planner";
import { Context } from "app/infrastructure/bot/bot.types";
import { StartConversation } from "app/infrastructure/bot/conversation/start/start.conversation";
import { PRIORITY } from "app/domain/broker/broker.types";

@injectable()
export class StartCommand extends Command {
    public readonly command: string = "start";

    public readonly description: string = "Главное меню / Main menu";

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor,
        @inject<StartConversation>(Modules.Bot.Conversations.Start) private readonly startConversation: StartConversation,
    ) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        return this.startConversation.enter(ctx);
    }

    private async generateRandomFonts(ctx: Context): Promise<void> {
        try {
            const start = dayjs();
            const woffPath = path.join(this.config.rootDir, "temp", "test-font.woff");

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
