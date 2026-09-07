import { FileHelper } from "app/helper/file-helper/file-helper";
import { ProcessHelper } from "app/helper/process-helper/process-helper";
import { injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/domain/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";

@injectable()
export class FontForge {
    @ConfigValue<string>("fontForgePath")
    private readonly fontForgePath!: string;

    private readonly supportedExtensions = [Extension.EOT, Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    // Пути читаются из sys.argv, а не подставляются в текст скрипта: у fontforge -c
    // sys.argv — это ["-c", ...аргументы после скрипта], и путь в нём остаётся строкой.
    // Подстановка сделала бы его питоновским кодом — вторым уровнем интерпретации после shell.
    private readonly convertScript = "import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])";

    public async convert(srcPath: string, distPath: string): Promise<void> {
        const srcExtension = await FileHelper.getFileExtension(srcPath);
        const distExtension = await FileHelper.getFileExtension(distPath);

        if (!this.supportedExtensions.includes(srcExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(srcExtension);
        }

        if (!this.supportedExtensions.includes(distExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(distExtension);
        }

        try {
            await ProcessHelper.run(this.fontForgePath, ["-c", this.convertScript, srcPath, distPath]);
        } catch (error) {
            throw ExecuteError.byError(error);
        }
    }
}
