import { FontForgeConvertor } from "app/font-convertor/convertor/font-forge-convertor";
import { Extension } from "app/font-convertor/font-convertor.types";

export class TtfToOtf extends FontForgeConvertor {
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.OTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.fontForge.convert(originPath, newPath);
    }
}
