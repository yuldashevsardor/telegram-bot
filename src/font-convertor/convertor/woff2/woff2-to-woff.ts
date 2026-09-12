import { FontForgeConvertor } from "app/font-convertor/convertor/font-forge-convertor";
import { Extension } from "app/font-convertor/font-convertor.types";

export class Woff2ToWoff extends FontForgeConvertor {
    protected fromExtension: Extension = Extension.WOFF2;
    protected toExtension: Extension = Extension.WOFF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
