import "reflect-metadata";
import { expect } from "chai";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import type { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SupportedFormats } from "app/telegram/supported-formats";

describe("SupportedFormats", function () {
    // The list does not build a convertor, so the factory gets none of its dependencies.
    it("names the formats of the pair matrix in upper case and in the order of the customer journey", function () {
        const convertorFactory = new ConvertorFactory({} as FontForge, {} as FontValidatorResolver, {} as EotPacker);

        expect(new SupportedFormats(convertorFactory).toText()).to.equal("TTF, OTF, WOFF, WOFF2, EOT, SVG");
    });

    // A matrix with a format that is only a target and a pair left out.
    const partialFactory = {
        getSourceExtensions: () => [Extension.SVG, Extension.TTF],
        getTargetExtensions: (fromExtension: Extension) =>
            fromExtension === Extension.SVG ? [Extension.WOFF2, Extension.TTF] : [Extension.SVG],
    } as unknown as ConvertorFactory;

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
