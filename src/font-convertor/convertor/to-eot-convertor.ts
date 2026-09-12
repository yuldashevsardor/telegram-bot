import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { TwoStepEotConvertor } from "app/domain/font-convertor/convertor/two-step-eot-convertor";

/**
 * Пара «формат → EOT» для всего, кроме TTF: движок доводит шрифт до sfnt, конверт
 * надевается уже поверх.
 */
export abstract class ToEotConvertor extends TwoStepEotConvertor {
    protected toExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);

        const sfntPath = this.intermediatePath(newPath);

        await this.throughIntermediate(sfntPath, async () => {
            await this.fontForge.convert(originPath, sfntPath);
            await this.eotPacker.pack(sfntPath, newPath);
        });
    }
}
