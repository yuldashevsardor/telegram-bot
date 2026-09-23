import { Extension } from "app/font-convertor/font-convertor.types";
import { TwoStepEotConvertor } from "app/font-convertor/convertor/two-step-eot-convertor";

/**
 * A "format → EOT" pair for every format but TTF: the engine brings the font to sfnt, and the
 * envelope goes on top of that.
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
