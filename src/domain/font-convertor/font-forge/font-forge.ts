import { FileHelper } from "app/helper/file-helper/file-helper";
import { ProcessHelper } from "app/helper/process-helper/process-helper";
import { injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/domain/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { InjectConfig } from "app/common/inject-config";

@injectable()
export class FontForge {
    // EOT здесь нет намеренно: движок не читает его конверт, а на запись молча
    // отдаёт PostScript Type 1 под чужим расширением. Конверт снимает и надевает
    // EotPacker, движку достаётся уже sfnt
    // (issue https://github.com/yuldashevsardor/telegram-bot/issues/158).
    private readonly supportedExtensions = [Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    // Пути читаются из sys.argv, а не подставляются в текст скрипта: у fontforge -c
    // sys.argv — это ["-c", ...аргументы после скрипта], и путь в нём остаётся строкой.
    // Подстановка сделала бы его питоновским кодом — вторым уровнем интерпретации после shell.
    private readonly convertScript = "import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])";

    public constructor(@InjectConfig("fontForgePath") private readonly fontForgePath: string) {}

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
