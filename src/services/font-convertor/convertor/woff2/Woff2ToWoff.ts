import { Convertor } from "../Convertor";
import { Extension, mimeTypesByExtension } from "../../Types";
import { FontConvertorHelper } from "../../FontConvertorHelper";

export class Woff2ToWoff extends Convertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.WOFF2];
    protected fromExtension: Extension = Extension.WOFF2;
    protected toExtension: Extension = Extension.WOFF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await FontConvertorHelper.convertViaPythonFontTools(originPath, newPath, this.toExtension);
    }
}
