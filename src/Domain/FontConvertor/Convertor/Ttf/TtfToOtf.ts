import { FontForgeConvertor } from "App/Domain/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Domain/FontConvertor/Types";

export class TtfToOtf extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.TTF];
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.OTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
