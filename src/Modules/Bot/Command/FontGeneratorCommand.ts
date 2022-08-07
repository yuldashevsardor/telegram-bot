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

@injectable()
export class FontGeneratorCommand extends Command {
    protected readonly command: string = "font_generator";

    public constructor(
        @inject<Config>(Infrastructure.Config) private readonly config: Config,
        @inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor,
    ) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        const promises: any[] = [];
        for (let i = 0; i < 1; i++) {
            promises.push(new Promise(this.generateRandomFonts.bind(this, ctx)));
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
}
