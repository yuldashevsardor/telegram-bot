import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";

// The fontforge of the image, found by PATH.
export const FONT_FORGE_PATH = "fontforge";

export function realFontValidatorResolver(): FontValidatorResolver {
    return new FontValidatorResolver(
        new SvgFontValidator(),
        new WoffFontValidator(new SfntFontValidator()),
        new Woff2FontValidator(new SfntFontValidator()),
        new SfntFontValidator(),
        new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()),
    );
}

/**
 * The factory the bot builds: the real engine, codec and validators. The resolver is passed in for
 * a spec that checks the results by the same validators.
 */
export function realConvertorFactory(resolver: FontValidatorResolver): ConvertorFactory {
    return new ConvertorFactory(new FontForge(FONT_FORGE_PATH), resolver, new EotPacker(new EotPayloadDecoder()));
}
