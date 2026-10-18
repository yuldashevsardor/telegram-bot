import { expect } from "chai";
import { Extension } from "app/font-convertor/font-convertor.types";
import { BrokenEot, NotEot } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { BrokenFont, NoFont, NotSvg, NotXml } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import { BrokenWoff, NotWoff } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import { BrokenWoff2, NotWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import { ReadFailed } from "app/shared/fs/file-helper.errors";
import { FontRejectionClassifier } from "app/telegram/middleware/file-intake/font-rejection-classifier";
import { FontRejection } from "app/telegram/middleware/file-intake/font-rejection-classifier.types";

const classifier = new FontRejectionClassifier();

describe("FontRejectionClassifier", function () {
    const notInFormat: Array<[Extension, Error]> = [
        [Extension.TTF, new NotSfnt("not sfnt")],
        [Extension.OTF, new NotSfnt("not sfnt")],
        [Extension.WOFF, new NotWoff("not woff")],
        [Extension.WOFF2, new NotWoff2("not woff2")],
        [Extension.EOT, new NotEot("not eot")],
        [Extension.SVG, new NotXml("not xml")],
        [Extension.SVG, new NotSvg("not svg")],
        [Extension.SVG, new NoFont("no font")],
    ];

    for (const [extension, error] of notInFormat) {
        it(`takes ${error.constructor.name} of a ${extension.toUpperCase()} file for a file not in the format`, function () {
            expect(classifier.classify(extension, error)).to.equal(FontRejection.NotInFormat);
        });
    }

    const broken: Array<[Extension, Error]> = [
        [Extension.TTF, new BrokenSfnt("broken sfnt")],
        [Extension.WOFF, new BrokenWoff("broken woff")],
        [Extension.WOFF2, new BrokenWoff2("broken woff2")],
        [Extension.EOT, new BrokenEot("broken eot")],
        [Extension.SVG, new BrokenFont("broken font")],
    ];

    for (const [extension, error] of broken) {
        it(`takes ${error.constructor.name} of a ${extension.toUpperCase()} file for a broken file`, function () {
            expect(classifier.classify(extension, error)).to.equal(FontRejection.Broken);
        });
    }

    // The container is in its format, the font inside is not.
    for (const extension of [Extension.WOFF, Extension.WOFF2, Extension.EOT]) {
        it(`takes NotSfnt of the font inside a ${extension.toUpperCase()} file for a broken file`, function () {
            expect(classifier.classify(extension, new NotSfnt("not sfnt"))).to.equal(FontRejection.Broken);
        });
    }

    it("takes no error of reading the file for a refusal", function () {
        expect(classifier.classify(Extension.TTF, new ReadFailed("read failed"))).to.equal(undefined);
    });
});
