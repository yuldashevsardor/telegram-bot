import { FontForgeConvertor } from "app/domain/font-convertor/convertor/font-forge-convertor";
import { Extension, mimeTypesByExtension } from "app/domain/font-convertor/font-convertor.types";

export class TtfToOtf extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.TTF];
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.OTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
