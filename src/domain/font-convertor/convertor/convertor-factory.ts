import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { ConvertorNotFound } from "app/domain/font-convertor/font-convertor.errors";
import { WoffToEot } from "app/domain/font-convertor/convertor/woff/woff-to-eot";
import { Convertor } from "app/domain/font-convertor/convertor/convertor";
import { WoffToOtf } from "app/domain/font-convertor/convertor/woff/woff-to-otf";
import { WoffToTtf } from "app/domain/font-convertor/convertor/woff/woff-to-ttf";
import { WoffToWoff2 } from "app/domain/font-convertor/convertor/woff/woff-to-woff2";
import { Woff2ToEot } from "app/domain/font-convertor/convertor/woff2/woff2-to-eot";
import { inject, injectable } from "inversify";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { Tokens } from "app/common/tokens";
import { EotToWoff2 } from "app/domain/font-convertor/convertor/eot/eot-to-woff2";
import { EotToWoff } from "app/domain/font-convertor/convertor/eot/eot-to-woff";
import { EotToTtf } from "app/domain/font-convertor/convertor/eot/eot-to-ttf";
import { EotToOtf } from "app/domain/font-convertor/convertor/eot/eot-to-otf";
import { OtfToWoff2 } from "app/domain/font-convertor/convertor/otf/otf-to-woff2";
import { OtfToWoff } from "app/domain/font-convertor/convertor/otf/otf-to-woff";
import { OtfToTtf } from "app/domain/font-convertor/convertor/otf/otf-to-ttf";
import { OtfToEot } from "app/domain/font-convertor/convertor/otf/otf-to-eot";
import { TtfToWoff2 } from "app/domain/font-convertor/convertor/ttf/ttf-to-woff2";
import { TtfToWoff } from "app/domain/font-convertor/convertor/ttf/ttf-to-woff";
import { TtfToOtf } from "app/domain/font-convertor/convertor/ttf/ttf-to-otf";
import { TtfToEot } from "app/domain/font-convertor/convertor/ttf/ttf-to-eot";
import { Woff2ToWoff } from "app/domain/font-convertor/convertor/woff2/woff2-to-woff";
import { Woff2ToTtf } from "app/domain/font-convertor/convertor/woff2/woff2-to-ttf";
import { Woff2ToOtf } from "app/domain/font-convertor/convertor/woff2/woff2-to-otf";
import { SvgToEot } from "app/domain/font-convertor/convertor/svg/svg-to-eot";
import { SvgToOtf } from "app/domain/font-convertor/convertor/svg/svg-to-otf";
import { SvgToTtf } from "app/domain/font-convertor/convertor/svg/svg-to-ttf";
import { SvgToWoff } from "app/domain/font-convertor/convertor/svg/svg-to-woff";
import { SvgToWoff2 } from "app/domain/font-convertor/convertor/svg/svg-to-woff2";
import { WoffToSvg } from "app/domain/font-convertor/convertor/woff/woff-to-svg";
import { Woff2ToSvg } from "app/domain/font-convertor/convertor/woff2/woff2-to-svg";
import { TtfToSvg } from "app/domain/font-convertor/convertor/ttf/ttf-to-svg";
import { OtfToSvg } from "app/domain/font-convertor/convertor/otf/otf-to-svg";
import { EotToSvg } from "app/domain/font-convertor/convertor/eot/eot-to-svg";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";
import { EotPacker } from "app/domain/font-convertor/eot-packer/eot-packer";

type ConvertorConstructor = new (fontForge: FontForge, fontSignatureMatcher: FontSignatureMatcher, eotPacker: EotPacker) => Convertor;

type ConvertorMatrix = Partial<Record<Extension, Partial<Record<Extension, ConvertorConstructor>>>>;

@injectable()
export class ConvertorFactory {
    // Матрица пар — единственное место, где записано, что домен умеет: из неё выбирается
    // конвертер, и из неё же выводится список поддерживаемых форматов. Формат, объявленный
    // в Extension, но не встречающийся здесь, поддерживаемым не считается.
    private readonly convertors: ConvertorMatrix = {
        [Extension.WOFF]: {
            [Extension.EOT]: WoffToEot,
            [Extension.OTF]: WoffToOtf,
            [Extension.SVG]: WoffToSvg,
            [Extension.TTF]: WoffToTtf,
            [Extension.WOFF2]: WoffToWoff2,
        },
        [Extension.WOFF2]: {
            [Extension.EOT]: Woff2ToEot,
            [Extension.OTF]: Woff2ToOtf,
            [Extension.SVG]: Woff2ToSvg,
            [Extension.TTF]: Woff2ToTtf,
            [Extension.WOFF]: Woff2ToWoff,
        },
        [Extension.TTF]: {
            [Extension.EOT]: TtfToEot,
            [Extension.OTF]: TtfToOtf,
            [Extension.SVG]: TtfToSvg,
            [Extension.WOFF]: TtfToWoff,
            [Extension.WOFF2]: TtfToWoff2,
        },
        [Extension.OTF]: {
            [Extension.EOT]: OtfToEot,
            [Extension.SVG]: OtfToSvg,
            [Extension.TTF]: OtfToTtf,
            [Extension.WOFF]: OtfToWoff,
            [Extension.WOFF2]: OtfToWoff2,
        },
        [Extension.EOT]: {
            [Extension.OTF]: EotToOtf,
            [Extension.SVG]: EotToSvg,
            [Extension.TTF]: EotToTtf,
            [Extension.WOFF]: EotToWoff,
            [Extension.WOFF2]: EotToWoff2,
        },
        [Extension.SVG]: {
            [Extension.EOT]: SvgToEot,
            [Extension.OTF]: SvgToOtf,
            [Extension.TTF]: SvgToTtf,
            [Extension.WOFF]: SvgToWoff,
            [Extension.WOFF2]: SvgToWoff2,
        },
    };

    public constructor(
        @inject<FontForge>(Tokens.Font.Engine.FontForge) private readonly fontForge: FontForge,
        @inject<FontSignatureMatcher>(Tokens.Font.Signature.Matcher)
        private readonly fontSignatureMatcher: FontSignatureMatcher,
        @inject<EotPacker>(Tokens.Font.Envelope.Packer) private readonly eotPacker: EotPacker,
    ) {}

    public get(fromExtension: Extension, toExtension: Extension): Convertor {
        const convertor = this.convertors[fromExtension]?.[toExtension];

        if (convertor === undefined) {
            throw ConvertorNotFound.byExtensions(fromExtension, toExtension);
        }

        return new convertor(this.fontForge, this.fontSignatureMatcher, this.eotPacker);
    }

    /**
     * Форматы, участвующие хотя бы в одной паре конвертации.
     */
    public getSupportedExtensions(): Array<Extension> {
        const extensions = new Set<Extension>();

        for (const fromExtension of Object.keys(this.convertors) as Array<Extension>) {
            extensions.add(fromExtension);

            for (const toExtension of Object.keys(this.convertors[fromExtension] ?? {}) as Array<Extension>) {
                extensions.add(toExtension);
            }
        }

        return Array.from(extensions);
    }
}
