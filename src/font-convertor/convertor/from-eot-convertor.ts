import { Extension } from "app/font-convertor/font-convertor.types";
import { TwoStepEotConvertor } from "app/font-convertor/convertor/two-step-eot-convertor";

/**
 * Пара «EOT → формат» для всего, кроме TTF: конверт снимается здесь, а дальше движок
 * работает с обычным sfnt.
 */
export abstract class FromEotConvertor extends TwoStepEotConvertor {
    protected fromExtension: Extension = Extension.EOT;

    public async convert(originPath: string, newPath: string): Promise<void> {
        await this.validate(originPath, newPath);

        const sfntPath = this.intermediatePath(newPath);

        await this.throughIntermediate(sfntPath, async () => {
            await this.eotPacker.unpack(originPath, sfntPath);
            await this.fontForge.convert(sfntPath, newPath);
        });
    }
}
