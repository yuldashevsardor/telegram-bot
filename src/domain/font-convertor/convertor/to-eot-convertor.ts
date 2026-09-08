import { EotConvertor } from "app/domain/font-convertor/convertor/eot-convertor";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FileHelper } from "app/helper/file-helper/file-helper";

/**
 * Пара «формат → EOT» для всего, кроме TTF: движок доводит шрифт до sfnt, конверт
 * надевается уже поверх.
 */
export abstract class ToEotConvertor extends EotConvertor {
    protected toExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);

        const sfntPath = this.intermediatePath(newPath);

        try {
            await this.fontForge.convert(originPath, sfntPath);
            await this.eotPacker.pack(sfntPath, newPath);
        } finally {
            await FileHelper.remove(sfntPath);
        }
    }
}
