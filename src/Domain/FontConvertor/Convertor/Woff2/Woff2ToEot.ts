import { FontForgeConvertor } from "App/Domain/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Domain/FontConvertor/Types";

export class Woff2ToEot extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.WOFF2];
    protected fromExtension: Extension = Extension.WOFF2;
    protected toExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
