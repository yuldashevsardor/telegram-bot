import { FontForgeConvertor } from "App/Domain/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Domain/FontConvertor/Types";

export class WoffToWoff2 extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.WOFF];
    protected fromExtension: Extension = Extension.WOFF;
    protected toExtension: Extension = Extension.WOFF2;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
