import { Convertor } from "app/font-convertor/convertor/convertor";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";

/**
 * A pair the codec alone is enough for: the source and the result differ only by the envelope.
 * The engine still comes into the constructor — `ConvertorFactory` sets the order of parameters.
 */
export abstract class EotConvertor extends Convertor {
    public constructor(_fontForge: FontForge, fontSignatureMatcher: FontSignatureMatcher, protected readonly eotPacker: EotPacker) {
        super(fontSignatureMatcher);
    }
}
