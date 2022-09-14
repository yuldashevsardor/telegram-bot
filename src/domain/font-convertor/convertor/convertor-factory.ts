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
import { Services } from "app/infrastructure/container/symbols/services";
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

@injectable()
export class ConvertorFactory {
    public constructor(@inject<FontForge>(Services.FontConvertor.FontForge) private readonly fontForge: FontForge) {}

    public get(fromExtension: Extension, toExtension: Extension): Convertor {
        if (fromExtension === Extension.WOFF) {
            return this.getWOFFConvertor(toExtension);
        }

        if (fromExtension === Extension.WOFF2) {
            return this.getWOFF2Convertor(toExtension);
        }

        if (fromExtension === Extension.TTF) {
            return this.getTTFConvertor(toExtension);
        }

        if (fromExtension === Extension.OTF) {
            return this.getOTFConvertor(toExtension);
        }

        if (fromExtension === Extension.EOT) {
            return this.getEOTConvertor(toExtension);
        }

        throw ConvertorNotFound.byExtensions(fromExtension, toExtension);
    }

    private getWOFFConvertor(toExtension: Extension): Convertor {
        if (toExtension === Extension.EOT) {
            return new WoffToEot(this.fontForge);
        }

        if (toExtension === Extension.OTF) {
            return new WoffToOtf(this.fontForge);
        }

        if (toExtension === Extension.TTF) {
            return new WoffToTtf(this.fontForge);
        }

        if (toExtension === Extension.WOFF2) {
            return new WoffToWoff2(this.fontForge);
        }

        throw ConvertorNotFound.byExtensions(Extension.WOFF, toExtension);
    }

    private getWOFF2Convertor(toExtension: Extension): Convertor {
        if (toExtension === Extension.EOT) {
            return new Woff2ToEot(this.fontForge);
        }

        if (toExtension === Extension.OTF) {
            return new Woff2ToOtf(this.fontForge);
        }

        if (toExtension === Extension.TTF) {
            return new Woff2ToTtf(this.fontForge);
        }

        if (toExtension === Extension.WOFF) {
            return new Woff2ToWoff(this.fontForge);
        }

        throw ConvertorNotFound.byExtensions(Extension.WOFF2, toExtension);
    }

    private getTTFConvertor(toExtension: Extension): Convertor {
        if (toExtension === Extension.EOT) {
            return new TtfToEot(this.fontForge);
        }

        if (toExtension === Extension.OTF) {
            return new TtfToOtf(this.fontForge);
        }

        if (toExtension === Extension.WOFF) {
            return new TtfToWoff(this.fontForge);
        }

        if (toExtension === Extension.WOFF2) {
            return new TtfToWoff2(this.fontForge);
        }

        throw ConvertorNotFound.byExtensions(Extension.TTF, toExtension);
    }

    private getOTFConvertor(toExtension: Extension): Convertor {
        if (toExtension === Extension.EOT) {
            return new OtfToEot(this.fontForge);
        }

        if (toExtension === Extension.TTF) {
            return new OtfToTtf(this.fontForge);
        }

        if (toExtension === Extension.WOFF) {
            return new OtfToWoff(this.fontForge);
        }

        if (toExtension === Extension.WOFF2) {
            return new OtfToWoff2(this.fontForge);
        }

        throw ConvertorNotFound.byExtensions(Extension.OTF, toExtension);
    }

    private getEOTConvertor(toExtension: Extension): Convertor {
        if (toExtension === Extension.OTF) {
            return new EotToOtf(this.fontForge);
        }

        if (toExtension === Extension.TTF) {
            return new EotToTtf(this.fontForge);
        }

        if (toExtension === Extension.WOFF) {
            return new EotToWoff(this.fontForge);
        }

        if (toExtension === Extension.WOFF2) {
            return new EotToWoff2(this.fontForge);
        }

        throw ConvertorNotFound.byExtensions(Extension.EOT, toExtension);
    }
}
