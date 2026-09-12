import { EotConvertor } from "app/domain/font-convertor/convertor/eot-convertor";
import { Extension } from "app/domain/font-convertor/font-convertor.types";

export class TtfToEot extends EotConvertor {
    protected fromExtension: Extension = Extension.TTF;
    protected toExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);
        await this.eotPacker.pack(originPath, newPath);
    }
}
