import { Convertor } from "../Convertor";
import { Extension, mimeTypesByExtension } from "../../Types";
import { FontConvertorHelper } from "../../FontConvertorHelper";

export class WoffToWoff2 extends Convertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.WOFF];
    protected fromExtension: Extension = Extension.WOFF;
    protected toExtension: Extension = Extension.WOFF2;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await FontConvertorHelper.convertViaPythonFontTools(originPath, newPath, this.toExtension);
    }
}
