import { inject, injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import type { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import type { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { SignatureFontValidator } from "app/font-convertor/validator/signature-font-validator";
import { Tokens } from "app/shared/tokens";

/**
 * Gives out the validator of a format. The validators are made once: the signature ones here, the
 * SVG and sfnt ones by the container. Every pair takes the one of its source format.
 */
@injectable()
export class FontValidatorResolver {
    private readonly validatorsByExtension: Record<Extension, FontValidator>;

    public constructor(
        @inject<FontSignatureMatcher>(Tokens.Font.Signature.Matcher) fontSignatureMatcher: FontSignatureMatcher,
        @inject<SvgFontValidator>(Tokens.Font.Validator.Svg) svgFontValidator: SvgFontValidator,
        @inject<SfntFontValidator>(Tokens.Font.Validator.Sfnt) sfntFontValidator: SfntFontValidator,
    ) {
        // SVG has no signature: its first bytes say at most "this is markup", not "this is a font",
        // so its validator reads the whole document. TTF and OTF share the sfnt container, and one
        // validator checks it under both extensions together with its version, the signature.
        this.validatorsByExtension = {
            [Extension.TTF]: sfntFontValidator,
            [Extension.OTF]: sfntFontValidator,
            [Extension.WOFF]: new SignatureFontValidator(fontSignatureMatcher, Extension.WOFF),
            [Extension.WOFF2]: new SignatureFontValidator(fontSignatureMatcher, Extension.WOFF2),
            [Extension.EOT]: new SignatureFontValidator(fontSignatureMatcher, Extension.EOT),
            [Extension.SVG]: svgFontValidator,
        };
    }

    public get(extension: Extension): FontValidator {
        return this.validatorsByExtension[extension];
    }
}
