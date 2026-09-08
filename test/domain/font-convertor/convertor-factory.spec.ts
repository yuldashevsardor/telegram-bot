import "reflect-metadata";
import { expect } from "chai";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { ConvertorFactory } from "app/domain/font-convertor/convertor/convertor-factory";
import { ConvertorNotFound } from "app/domain/font-convertor/font-convertor.errors";
import { FontForge } from "app/domain/font-convertor/font-forge/font-forge";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

const convertorFactory = new ConvertorFactory({} as FontForge, new FontSignatureMatcher());

// Имя класса пары строится так же, как имя его файла: <from>-to-<to>.ts.
function convertorClassName(fromExtension: Extension, toExtension: Extension): string {
    const pascal = (extension: Extension): string => extension.charAt(0).toUpperCase() + extension.slice(1);

    return `${pascal(fromExtension)}To${pascal(toExtension)}`;
}

describe("ConvertorFactory.getSupportedExtensions", function () {
    it("returns every extension of the conversion matrix and nothing else", function () {
        // SVG объявлен в Extension намеченным форматом и пар не имеет, поэтому
        // поддерживаемым не считается.
        expect(convertorFactory.getSupportedExtensions()).to.have.members([
            Extension.WOFF,
            Extension.WOFF2,
            Extension.TTF,
            Extension.OTF,
            Extension.EOT,
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

    it("throws for an extension without pairs", function () {
        expect(() => convertorFactory.get(Extension.SVG, Extension.WOFF)).to.throw(ConvertorNotFound);
        expect(() => convertorFactory.get(Extension.WOFF, Extension.SVG)).to.throw(ConvertorNotFound);
    });

    it("throws when the extensions are equal", function () {
        expect(() => convertorFactory.get(Extension.WOFF, Extension.WOFF)).to.throw(ConvertorNotFound);
    });
});
