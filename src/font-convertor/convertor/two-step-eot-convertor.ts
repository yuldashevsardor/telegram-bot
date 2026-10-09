import { Convertor } from "app/font-convertor/convertor/convertor";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";

/**
 * An EOT pair that needs both: the codec takes the envelope off or puts it on, the engine moves
 * the outlines. Between them an intermediate sfnt stays on disk.
 */
export abstract class TwoStepEotConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontValidatorResolver: FontValidatorResolver,
        protected readonly eotPacker: EotPacker,
    ) {
        super(fontValidatorResolver);
    }

    /**
     * The path of the intermediate sfnt: the result name is unique in its directory, so a name
     * derived from it is unique too.
     */
    protected intermediatePath(newPath: string): string {
        return `${newPath}.${Extension.TTF}`;
    }
}
