import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import path from "path";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { Tokens } from "app/common/tokens";
import { configValue } from "app/common/config-value";
import { Extension } from "app/font-convertor/font-convertor.types";
import { Context } from "app/telegram/bot.types";
import { Logger } from "app/domain/logger/logger";

@injectable()
export class FontGeneratorCommand extends Command {
    public readonly command: string = "font_generator";
    public readonly descriptionKey: string = "font-generator-command-description";

    public constructor(
        @inject<FontConvertor>(Tokens.Font.Convertor.Convertor) private readonly convertor: FontConvertor,
        @inject<Logger>(Tokens.Infrastructure.Logger) private readonly logger: Logger,
        private readonly rootDir: string = configValue("rootDir"),
    ) {
        super();
    }

    protected async handle(ctx: Context): Promise<void> {
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < 1; i++) {
            promises.push(this.generateRandomFonts(ctx));
        }

        await Promise.all(promises);
    }

    private async generateRandomFonts(ctx: Context): Promise<void> {
        try {
            const woffPath = path.join(this.rootDir, "test", "fixtures", "fonts", "test-font.woff");

            const eotPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.EOT,
            });
            await ctx.reply(ctx.t("font-generator-result", { path: eotPath }));

            const otfPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.OTF,
            });
            await ctx.reply(ctx.t("font-generator-result", { path: otfPath }));

            const ttfPath = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.TTF,
            });
            await ctx.reply(ctx.t("font-generator-result", { path: ttfPath }));

            const woff2Path = await this.convertor.convert({
                originPath: woffPath,
                extension: Extension.WOFF2,
            });
            await ctx.reply(ctx.t("font-generator-result", { path: woff2Path }));
        } catch (error) {
            this.logger.error("Font generation is failed.", { cause: error });
        }
    }
}
