import { FontForgeConvertor } from "App/Services/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Services/FontConvertor/Types";

export class OtfToTtf extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.OTF];
    protected fromExtension: Extension = Extension.OTF;
    protected toExtension: Extension = Extension.TTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
