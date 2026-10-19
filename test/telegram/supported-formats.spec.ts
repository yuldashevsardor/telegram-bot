import "reflect-metadata";
import { expect } from "chai";
import type { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SupportedFormats } from "app/telegram/supported-formats";
import { supportedFormats } from "test/telegram/handler.helper";

describe("SupportedFormats", function () {
    // The shared stub is SupportedFormats itself over the real pair table.
    it("names the formats of the pair matrix in upper case and in the order of the customer journey", function () {
        expect(supportedFormats.toText()).to.equal("TTF, OTF, WOFF, WOFF2, EOT, SVG");
    });

    // A matrix with a format that is only a target and a pair left out.
    const partialFactory = {
        getSourceExtensions: () => [Extension.SVG, Extension.TTF],
        getTargetExtensions: (fromExtension: Extension) =>
            fromExtension === Extension.SVG ? [Extension.WOFF2, Extension.TTF] : [Extension.SVG],
    } as unknown as ConvertorFactory;

    it("names the formats a pair starts from in upper case, in the order of the customer journey", function () {
        expect(new SupportedFormats(partialFactory).toSourceText()).to.equal("TTF, SVG");
    });

    it("takes in the formats a pair starts from, in the order of the customer journey", function () {
        expect(new SupportedFormats(partialFactory).toSourceList()).to.deep.equal([Extension.TTF, Extension.SVG]);
    });

    it("offers the targets of the pairs of the source, in the order of the customer journey", function () {
        expect(new SupportedFormats(partialFactory).toTargetList(Extension.SVG)).to.deep.equal([Extension.TTF, Extension.WOFF2]);
    });

    // The list follows the matrix: a format it loses is not promised.
    it("names only the formats the pair matrix gives", function () {
        const convertorFactory = {
            getSupportedExtensions: () => [Extension.SVG, Extension.WOFF2, Extension.TTF],
        } as unknown as ConvertorFactory;

        expect(new SupportedFormats(convertorFactory).toText()).to.equal("TTF, WOFF2, SVG");
    });
});
