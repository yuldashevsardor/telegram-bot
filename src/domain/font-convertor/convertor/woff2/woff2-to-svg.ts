import { FontForgeConvertor } from "app/domain/font-convertor/convertor/font-forge-convertor";
import { Extension } from "app/domain/font-convertor/font-convertor.types";

export class Woff2ToSvg extends FontForgeConvertor {
    protected fromExtension: Extension = Extension.WOFF2;
    protected toExtension: Extension = Extension.SVG;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
