import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(protected readonly fontForge: FontForge, fontSignatureMatcher: FontSignatureMatcher) {
        super(fontSignatureMatcher);
    }
}
