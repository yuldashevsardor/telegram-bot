import { Extension } from "App/Domain/FontConvertor/Types";
import { ConvertorNotFound } from "App/Domain/FontConvertor/Errors";
import { WoffToEot } from "App/Domain/FontConvertor/Convertor/Woff/WoffToEot";
import { Convertor } from "App/Domain/FontConvertor/Convertor/Convertor";
import { WoffToOtf } from "App/Domain/FontConvertor/Convertor/Woff/WoffToOtf";
import { WoffToTtf } from "App/Domain/FontConvertor/Convertor/Woff/WoffToTtf";
import { WoffToWoff2 } from "App/Domain/FontConvertor/Convertor/Woff/WoffToWoff2";
import { Woff2ToEot } from "App/Domain/FontConvertor/Convertor/Woff2/Woff2ToEot";
import { inject, injectable } from "inversify";
import { FontForge } from "App/Domain/FontConvertor/FontForge/FontForge";
import { Services } from "App/Infrastructure/Config/Dependency/Symbols/Services";
import { EotToWoff2 } from "App/Domain/FontConvertor/Convertor/Eot/EotToWoff2";
import { EotToWoff } from "App/Domain/FontConvertor/Convertor/Eot/EotToWoff";
import { EotToTtf } from "App/Domain/FontConvertor/Convertor/Eot/EotToTtf";
import { EotToOtf } from "App/Domain/FontConvertor/Convertor/Eot/EotToOtf";
import { OtfToWoff2 } from "App/Domain/FontConvertor/Convertor/Otf/OtfToWoff2";
import { OtfToWoff } from "App/Domain/FontConvertor/Convertor/Otf/OtfToWoff";
import { OtfToTtf } from "App/Domain/FontConvertor/Convertor/Otf/OtfToTtf";
import { OtfToEot } from "App/Domain/FontConvertor/Convertor/Otf/OtfToEot";
import { TtfToWoff2 } from "App/Domain/FontConvertor/Convertor/Ttf/TtfToWoff2";
import { TtfToWoff } from "App/Domain/FontConvertor/Convertor/Ttf/TtfToWoff";
import { TtfToOtf } from "App/Domain/FontConvertor/Convertor/Ttf/TtfToOtf";
import { TtfToEot } from "App/Domain/FontConvertor/Convertor/Ttf/TtfToEot";
import { Woff2ToWoff } from "App/Domain/FontConvertor/Convertor/Woff2/Woff2ToWoff";
import { Woff2ToTtf } from "App/Domain/FontConvertor/Convertor/Woff2/Woff2ToTtf";
import { Woff2ToOtf } from "App/Domain/FontConvertor/Convertor/Woff2/Woff2ToOtf";

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
