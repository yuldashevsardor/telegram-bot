import { Convertor } from "app/font-convertor/convertor/convertor";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";

/**
 * A pair the codec alone is enough for: the source and the result differ only by the envelope.
 */
export abstract class EotConvertor extends Convertor {
    public constructor(fontValidatorResolver: FontValidatorResolver, protected readonly eotPacker: EotPacker) {
        super(fontValidatorResolver);
    }
}
