import { Extension } from "app/font-convertor/font-convertor.types";
import { TwoStepEotConvertor } from "app/font-convertor/convertor/two-step-eot-convertor";

/**
 * An "EOT → format" pair for every format but TTF: the envelope comes off here, and from then on
 * the engine works with a plain sfnt.
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
