import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessHelper } from "app/shared/process/process-helper";
import { injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { configValue } from "app/shared/config-value";

@injectable()
export class FontForge {
    // EOT is left out on purpose: the engine does not read its envelope, and on writing it
    // silently hands over PostScript Type 1 under a foreign extension. EotPacker takes the
    // envelope off and puts it on, so when an EOT pair needs the engine, the engine reads or
    // writes a plain sfnt, never the envelope
    // (issue https://github.com/yuldashevsardor/telegram-bot/issues/158).
    private readonly supportedExtensions = [Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    // The paths are read from sys.argv rather than substituted into the script text: under
    // fontforge -c, sys.argv is ["-c", ...the arguments after the script], and a path in it stays
    // a string. Substitution would make it Python code — a second level of interpretation after
    // the shell.
    private readonly convertScript = "import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])";

    public constructor(private readonly fontForgePath: string = configValue("fontForgePath")) {}

    public async convert(srcPath: string, distPath: string): Promise<void> {
        const srcExtension = (await FileHelper.getFileExtension(srcPath)).toLowerCase();
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
