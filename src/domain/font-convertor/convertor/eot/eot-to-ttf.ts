import { Extension, mimeTypesByExtension } from "app/domain/font-convertor/font-convertor.types";
import { FontForgeConvertor } from "app/domain/font-convertor/convertor/font-forge-convertor";

export class EotToTtf extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.EOT];
    protected fromExtension: Extension = Extension.EOT;
    protected toExtension: Extension = Extension.TTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
