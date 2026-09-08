import { EotConvertor } from "app/domain/font-convertor/convertor/eot-convertor";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FileHelper } from "app/helper/file-helper/file-helper";

/**
 * Пара «EOT → формат» для всего, кроме TTF: конверт снимается здесь, а дальше движок
 * работает с обычным sfnt.
 */
export abstract class FromEotConvertor extends EotConvertor {
    protected fromExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);

        const sfntPath = this.intermediatePath(newPath);

        try {
            await this.eotPacker.unpack(originPath, sfntPath);
            await this.fontForge.convert(sfntPath, newPath);
        } finally {
            await FileHelper.remove(sfntPath);
        }
    }
}
