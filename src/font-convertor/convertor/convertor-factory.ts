import { Extension } from "app/font-convertor/font-convertor.types";
import { ConvertorNotFound } from "app/font-convertor/font-convertor.errors";
import { WoffToEot } from "app/font-convertor/convertor/woff/woff-to-eot";
import type { Convertor } from "app/font-convertor/convertor/convertor";
import { WoffToOtf } from "app/font-convertor/convertor/woff/woff-to-otf";
import { WoffToTtf } from "app/font-convertor/convertor/woff/woff-to-ttf";
import { WoffToWoff2 } from "app/font-convertor/convertor/woff/woff-to-woff2";
import { Woff2ToEot } from "app/font-convertor/convertor/woff2/woff2-to-eot";
import { inject, injectable } from "inversify";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { Tokens } from "app/shared/tokens";
import { EotToWoff2 } from "app/font-convertor/convertor/eot/eot-to-woff2";
import { EotToWoff } from "app/font-convertor/convertor/eot/eot-to-woff";
import { EotToTtf } from "app/font-convertor/convertor/eot/eot-to-ttf";
import { EotToOtf } from "app/font-convertor/convertor/eot/eot-to-otf";
import { OtfToWoff2 } from "app/font-convertor/convertor/otf/otf-to-woff2";
import { OtfToWoff } from "app/font-convertor/convertor/otf/otf-to-woff";
import { OtfToTtf } from "app/font-convertor/convertor/otf/otf-to-ttf";
import { OtfToEot } from "app/font-convertor/convertor/otf/otf-to-eot";
import { TtfToWoff2 } from "app/font-convertor/convertor/ttf/ttf-to-woff2";
import { TtfToWoff } from "app/font-convertor/convertor/ttf/ttf-to-woff";
import { TtfToOtf } from "app/font-convertor/convertor/ttf/ttf-to-otf";
import { TtfToEot } from "app/font-convertor/convertor/ttf/ttf-to-eot";
import { Woff2ToWoff } from "app/font-convertor/convertor/woff2/woff2-to-woff";
import { Woff2ToTtf } from "app/font-convertor/convertor/woff2/woff2-to-ttf";
import { Woff2ToOtf } from "app/font-convertor/convertor/woff2/woff2-to-otf";
import { SvgToEot } from "app/font-convertor/convertor/svg/svg-to-eot";
import { SvgToOtf } from "app/font-convertor/convertor/svg/svg-to-otf";
import { SvgToTtf } from "app/font-convertor/convertor/svg/svg-to-ttf";
import { SvgToWoff } from "app/font-convertor/convertor/svg/svg-to-woff";
import { SvgToWoff2 } from "app/font-convertor/convertor/svg/svg-to-woff2";
import { WoffToSvg } from "app/font-convertor/convertor/woff/woff-to-svg";
import { Woff2ToSvg } from "app/font-convertor/convertor/woff2/woff2-to-svg";
import { TtfToSvg } from "app/font-convertor/convertor/ttf/ttf-to-svg";
import { OtfToSvg } from "app/font-convertor/convertor/otf/otf-to-svg";
import { EotToSvg } from "app/font-convertor/convertor/eot/eot-to-svg";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";

type ConvertorMatrix = Partial<Record<Extension, Partial<Record<Extension, () => Convertor>>>>;

@injectable()
export class ConvertorFactory {
    // The only record of what the domain can do: get() picks the convertor from it, and
    // getSupportedExtensions() derives the supported formats from it. A format declared in
    // Extension but absent here does not count as supported. An entry builds its pair itself, so
    // that a pair is handed only the dependencies it uses.
    private readonly convertors: ConvertorMatrix = {
        [Extension.WOFF]: {
            [Extension.EOT]: () => new WoffToEot(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.OTF]: () => new WoffToOtf(this.fontForge, this.fontValidatorResolver),
            [Extension.SVG]: () => new WoffToSvg(this.fontForge, this.fontValidatorResolver),
            [Extension.TTF]: () => new WoffToTtf(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF2]: () => new WoffToWoff2(this.fontForge, this.fontValidatorResolver),
        },
        [Extension.WOFF2]: {
            [Extension.EOT]: () => new Woff2ToEot(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.OTF]: () => new Woff2ToOtf(this.fontForge, this.fontValidatorResolver),
            [Extension.SVG]: () => new Woff2ToSvg(this.fontForge, this.fontValidatorResolver),
            [Extension.TTF]: () => new Woff2ToTtf(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF]: () => new Woff2ToWoff(this.fontForge, this.fontValidatorResolver),
        },
        [Extension.TTF]: {
            [Extension.EOT]: () => new TtfToEot(this.fontValidatorResolver, this.eotPacker),
            [Extension.OTF]: () => new TtfToOtf(this.fontForge, this.fontValidatorResolver),
            [Extension.SVG]: () => new TtfToSvg(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF]: () => new TtfToWoff(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF2]: () => new TtfToWoff2(this.fontForge, this.fontValidatorResolver),
        },
        [Extension.OTF]: {
            [Extension.EOT]: () => new OtfToEot(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.SVG]: () => new OtfToSvg(this.fontForge, this.fontValidatorResolver),
            [Extension.TTF]: () => new OtfToTtf(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF]: () => new OtfToWoff(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF2]: () => new OtfToWoff2(this.fontForge, this.fontValidatorResolver),
        },
        [Extension.EOT]: {
            [Extension.OTF]: () => new EotToOtf(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.SVG]: () => new EotToSvg(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.TTF]: () => new EotToTtf(this.fontValidatorResolver, this.eotPacker),
            [Extension.WOFF]: () => new EotToWoff(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.WOFF2]: () => new EotToWoff2(this.fontForge, this.fontValidatorResolver, this.eotPacker),
        },
        [Extension.SVG]: {
            [Extension.EOT]: () => new SvgToEot(this.fontForge, this.fontValidatorResolver, this.eotPacker),
            [Extension.OTF]: () => new SvgToOtf(this.fontForge, this.fontValidatorResolver),
            [Extension.TTF]: () => new SvgToTtf(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF]: () => new SvgToWoff(this.fontForge, this.fontValidatorResolver),
            [Extension.WOFF2]: () => new SvgToWoff2(this.fontForge, this.fontValidatorResolver),
        },
    };

    public constructor(
        @inject<FontForge>(Tokens.Font.Engine.FontForge) private readonly fontForge: FontForge,
        @inject<FontValidatorResolver>(Tokens.Font.Validator.Resolver) private readonly fontValidatorResolver: FontValidatorResolver,
        @inject<EotPacker>(Tokens.Font.Envelope.Packer) private readonly eotPacker: EotPacker,
    ) {}

    public get(fromExtension: Extension, toExtension: Extension): Convertor {
        const buildConvertor = this.convertors[fromExtension]?.[toExtension];

        if (buildConvertor === undefined) {
            throw ConvertorNotFound.byExtensions(fromExtension, toExtension);
        }

        return buildConvertor();
    }

    /**
     * The formats taking part in at least one conversion pair.
     */
    public getSupportedExtensions(): Array<Extension> {
        const extensions = new Set<Extension>();

        for (const [fromExtension, toConvertors] of Object.entries(this.convertors)) {
            extensions.add(fromExtension as Extension);

            for (const toExtension of Object.keys(toConvertors) as Array<Extension>) {
                extensions.add(toExtension);
            }
        }

        return Array.from(extensions);
    }
}
