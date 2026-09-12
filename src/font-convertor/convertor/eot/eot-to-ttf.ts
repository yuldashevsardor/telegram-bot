import { EotConvertor } from "app/domain/font-convertor/convertor/eot-convertor";
import { Extension } from "app/domain/font-convertor/font-convertor.types";

export class EotToTtf extends EotConvertor {
    protected fromExtension: Extension = Extension.EOT;
    protected toExtension: Extension = Extension.TTF;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.eotPacker.unpack(originPath, newPath);
    }
}
