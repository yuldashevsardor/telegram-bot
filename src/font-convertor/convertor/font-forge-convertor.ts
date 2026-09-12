import { Convertor } from "app/font-convertor/convertor/convertor";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge, fontSignatureMatcher: FontSignatureMatcher) {
        super(fontSignatureMatcher);
    }
}
