import { Command } from "App/Infrastructure/Bot/Command/Command";
import { inject, injectable } from "inversify";
import dayjs from "dayjs";
import path from "path";
import { FontConvertor } from "App/Domain/FontConvertor/FontConvertor";
import { Services } from "App/Infrastructure/Container/Symbols/Services";
import { Extension } from "App/Domain/FontConvertor/Types";
import { ConfigValue } from "App/Infrastructure/Config/ConfigValue";
import { Context } from "App/Infrastructure/Bot/Types";

@injectable()
export class FontGeneratorCommand extends Command {
    @ConfigValue<string>("tempDir")
    private readonly tempDir!: string;

    public readonly command: string = "font_generator";
    public readonly description: string = "Генерация случайных шрифтов / Generate random fonts";

    public constructor(@inject<FontConvertor>(Services.FontConvertor.FontConvertor) private readonly convertor: FontConvertor) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 1; i++) {
            promises.push(this.generateRandomFonts.bind(this, ctx));
        }

        await Promise.all(promises);
    }

    private async generateRandomFonts(ctx: Context): Promise<void> {
        try {
            const start = dayjs();
            const woffPath = path.join(this.tempDir, "app", "test-fonts", "test-font.woff");

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
