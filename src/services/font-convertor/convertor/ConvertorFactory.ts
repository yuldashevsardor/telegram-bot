import { Extension } from "../Types";
import { Convertor } from "./Convertor";
import { ConvertorNotFound } from "../Errors";
import { WoffToWoff2 } from "./woff/WoffToWoff2";
import { Woff2ToWoff } from "./woff2/Woff2ToWoff";

export class ConvertorFactory {
    public constructor(private readonly fromExtension: Extension, private readonly toExtension: Extension) {}

    public get(): Convertor {
        if (this.fromExtension === Extension.WOFF) {
            return this.getWOFFConvertor();
        }

        if (this.fromExtension === Extension.WOFF2) {
            return this.getWOFF2Convertor();
        }

        if (this.fromExtension === Extension.TTF) {
            return this.getTTFConvertor();
        }

        if (this.fromExtension === Extension.OTF) {
            return this.getOTFConvertor();
        }

        if (this.fromExtension === Extension.EOT) {
            return this.getEOTConvertor();
        }

        throw ConvertorNotFound.byExtensions(this.toExtension, this.toExtension);
    }

    private getWOFFConvertor(): Convertor {
        if (this.toExtension === Extension.WOFF2) {
            return new WoffToWoff2();
        }

        throw ConvertorNotFound.byExtensions(Extension.WOFF, this.toExtension);
    }

    private getWOFF2Convertor(): Convertor {
        if (this.toExtension === Extension.WOFF) {
            return new Woff2ToWoff();
        }

        throw ConvertorNotFound.byExtensions(Extension.WOFF2, this.toExtension);
    }

    private getTTFConvertor(): Convertor {
        throw ConvertorNotFound.byExtensions(Extension.TTF, this.toExtension);
    }

    private getOTFConvertor(): Convertor {
        throw ConvertorNotFound.byExtensions(Extension.OTF, this.toExtension);
    }

    private getEOTConvertor(): Convertor {
        throw ConvertorNotFound.byExtensions(Extension.EOT, this.toExtension);
    }
}
