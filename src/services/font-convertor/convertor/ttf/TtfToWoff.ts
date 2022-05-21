import { Convertor } from "../Convertor";
import { Extension, mimeTypesByExtension } from "../../Types";
import { FontConvertorHelper } from "../../FontConvertorHelper";

export class TtfToWoff extends Convertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.TTF];
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.WOFF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await FontConvertorHelper.convertViaPythonFontTools(originPath, newPath, this.toExtension);
    }
}
