import { Convertor } from "app/font-convertor/convertor/convertor";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";

/**
 * A pair the codec alone is enough for: the source and the result differ only by the envelope.
 * The constructor still takes the engine: `ConvertorFactory` sets the order of the parameters
 * for every pair.
 */
export abstract class EotConvertor extends Convertor {
    public constructor(_fontForge: FontForge, fontValidatorResolver: FontValidatorResolver, protected readonly eotPacker: EotPacker) {
        super(fontValidatorResolver);
    }
}
