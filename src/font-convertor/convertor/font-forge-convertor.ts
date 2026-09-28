import { Convertor } from "app/font-convertor/convertor/convertor";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import type { SvgFontValidator } from "app/font-convertor/svg-validator/svg-font-validator";

export abstract class FontForgeConvertor extends Convertor {
    public constructor(
        protected readonly fontForge: FontForge,
        fontSignatureMatcher: FontSignatureMatcher,
        svgFontValidator: SvgFontValidator,
    ) {
        super(fontSignatureMatcher, svgFontValidator);
    }
}
