import { FileHelper } from "app/helper/file-helper/file-helper";
import { promisify } from "util";
import { exec as execOrigin } from "child_process";
import { injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/domain/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";

@injectable()
export class FontForge {
    @ConfigValue<string>("fontForgePath")
    private readonly fontForgePath!: string;

    private readonly supportedExtensions = [Extension.EOT, Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    private readonly commandLayout = `{FONT_FORGE_PATH} -c 'import fontforge; font = fontforge.open("{SRC}"); font.generate("{DIST}")'`;
    private readonly commandVariableNames = {
        src: "{SRC}",
        dist: "{DIST}",
        fontForge: "{FONT_FORGE_PATH}",
    };

    public async convert(srcPath: string, distPath: string): Promise<void> {
        const srcExtension = await FileHelper.getFileExtension(srcPath);
        const distExtension = await FileHelper.getFileExtension(distPath);

        if (!this.supportedExtensions.includes(srcExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(srcExtension);
        }

        if (!this.supportedExtensions.includes(distExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(distExtension);
        }

        const command = this.commandLayout
            .replace(this.commandVariableNames.fontForge, this.fontForgePath)
            .replace(this.commandVariableNames.src, srcPath)
            .replace(this.commandVariableNames.dist, distPath);

        const exec = promisify(execOrigin);
        try {
            await exec(command);
        } catch (error) {
            throw ExecuteError.byError(error);
        }
    }
}
