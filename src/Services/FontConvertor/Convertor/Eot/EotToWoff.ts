import { FontForgeConvertor } from "App/Services/FontConvertor/Convertor/FontForgeConvertor";
import { Extension, mimeTypesByExtension } from "App/Services/FontConvertor/Types";

export class EotToWoff extends FontForgeConvertor {
    protected allowedMimeTypes: Array<string> = mimeTypesByExtension[Extension.EOT];
    protected fromExtension: Extension = Extension.EOT;
    protected toExtension: Extension = Extension.WOFF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
