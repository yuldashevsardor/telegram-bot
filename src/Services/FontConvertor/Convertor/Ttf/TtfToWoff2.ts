import { FontForgeConvertor } from "App/Services/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Services/FontConvertor/Types";

export class TtfToWoff2 extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.TTF];
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.WOFF2;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
