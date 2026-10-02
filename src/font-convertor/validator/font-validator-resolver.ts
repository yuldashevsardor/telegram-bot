import { inject, injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import type { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import type { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import type { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import type { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { Tokens } from "app/shared/tokens";

/**
 * Gives out the validator of a format. The validators are made once, by the container. Every pair
 * takes the one of its source format.
 */
@injectable()
export class FontValidatorResolver {
    private readonly validatorsByExtension: Record<Extension, FontValidator>;

    public constructor(
        @inject<SvgFontValidator>(Tokens.Font.Validator.Svg) svgFontValidator: SvgFontValidator,
        @inject<WoffFontValidator>(Tokens.Font.Validator.Woff) woffFontValidator: WoffFontValidator,
        @inject<Woff2FontValidator>(Tokens.Font.Validator.Woff2) woff2FontValidator: Woff2FontValidator,
        @inject<SfntFontValidator>(Tokens.Font.Validator.Sfnt) sfntFontValidator: SfntFontValidator,
        @inject<EotFontValidator>(Tokens.Font.Validator.Eot) eotFontValidator: EotFontValidator,
    ) {
        // SVG has no signature: its first bytes say at most "this is markup", not "this is a font",
        // so its validator reads the whole document. TTF and OTF share the sfnt container, and one
        // validator checks it under both extensions together with its version, the signature. WOFF,
        // WOFF2 and EOT have one too, but the validator of each checks it together with the rest of
        // the file.
        this.validatorsByExtension = {
            [Extension.TTF]: sfntFontValidator,
            [Extension.OTF]: sfntFontValidator,
            [Extension.WOFF]: woffFontValidator,
            [Extension.WOFF2]: woff2FontValidator,
            [Extension.EOT]: eotFontValidator,
            [Extension.SVG]: svgFontValidator,
        };
    }

    public get(extension: Extension): FontValidator {
        return this.validatorsByExtension[extension];
    }
}
