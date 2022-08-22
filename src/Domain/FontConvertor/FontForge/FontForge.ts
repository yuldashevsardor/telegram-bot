import { FileHelper } from "App/Infrastructure/Helpers/FileHelper/FileHelper";
import { promisify } from "util";
import { exec as execOrigin } from "child_process";
import { inject, injectable } from "inversify";
import { Config } from "App/Infrastructure/Config/Config";
import { Infrastructure } from "App/Infrastructure/Config/Dependency/Symbols/Infrastructure";
import { ExecuteError, ExtensionNotSupport } from "App/Domain/FontConvertor/FontForge/Errors";
import { Extension } from "App/Domain/FontConvertor/Types";

@injectable()
export class FontForge {
    private readonly fontForgePath: string;
    private readonly supportedExtensions = [Extension.EOT, Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    private readonly commandLayout = `{FONT_FORGE_PATH} -c 'import fontforge; font = fontforge.open("{SRC}"); font.generate("{DIST}")'`;
    private readonly commandVariableNames = {
        src: "{SRC}",
        dist: "{DIST}",
        fontForge: "{FONT_FORGE_PATH}",
    };

    public constructor(@inject(Infrastructure.Config) private readonly config: Config) {
        this.fontForgePath = this.config.fontForgePath;
    }

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
