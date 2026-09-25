import "reflect-metadata";
import { expect } from "chai";
import { Extension } from "app/font-convertor/font-convertor.types";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { ConvertorNotFound } from "app/font-convertor/font-convertor.errors";
import type { FontForge } from "app/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";

const convertorFactory = new ConvertorFactory({} as FontForge, new FontSignatureMatcher(), new EotPacker());

// A pair's class name is built the same way as its file name: <from>-to-<to>.ts.
function convertorClassName(fromExtension: Extension, toExtension: Extension): string {
    const pascal = (extension: Extension): string => extension.charAt(0).toUpperCase() + extension.slice(1);

    return `${pascal(fromExtension)}To${pascal(toExtension)}`;
}

describe("ConvertorFactory.getSupportedExtensions", function () {
    // The order is checked on purpose: the user sees the list in this order in the /start
    // welcome (StartConversation). The list follows the order of the matrix: a format enters it
    // where it first appears, as a source or a target. So reordering the matrix changes the welcome.
    it("returns every extension of the conversion matrix in the order of its first appearance", function () {
        expect(convertorFactory.getSupportedExtensions()).to.deep.equal([
            Extension.WOFF,
            Extension.EOT,
            Extension.OTF,
            Extension.SVG,
            Extension.TTF,
            Extension.WOFF2,
        ]);
    });
});

describe("ConvertorFactory.get", function () {
    const supported = convertorFactory.getSupportedExtensions();

    for (const fromExtension of supported) {
        for (const toExtension of supported.filter((extension) => extension !== fromExtension)) {
            it(`returns the ${fromExtension} to ${toExtension} convertor`, function () {
                expect(convertorFactory.get(fromExtension, toExtension).constructor.name).to.equal(
                    convertorClassName(fromExtension, toExtension),
                );
            });
        }
    }

    it("throws when the extensions are equal", function () {
        expect(() => convertorFactory.get(Extension.WOFF, Extension.WOFF)).to.throw(ConvertorNotFound);
    });
});
