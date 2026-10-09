import { expect } from "chai";
import { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";

// What decode() reads and how a file reads as "not XML" is checked through SvgFontValidator, in
// svg-font-validator.spec.ts. Here is the way back.
describe("SvgTextCodec.encode", function () {
    const textCodec = new SvgTextCodec();
    // A character outside the BMP is a surrogate pair in UTF-16, whose units swap apart.
    const text = "<svg>\u{1F600}é</svg>";

    it("writes UTF-8 without a BOM", function () {
        expect(Array.from(textCodec.encode("<é", "utf-8"))).to.deep.equal([0x3c, 0xc3, 0xa9]);
    });

    it("writes UTF-16 with the BOM of its byte order", function () {
        expect(Array.from(textCodec.encode("<é", "utf-16le"))).to.deep.equal([0xff, 0xfe, 0x3c, 0x00, 0xe9, 0x00]);
        expect(Array.from(textCodec.encode("<é", "utf-16be"))).to.deep.equal([0xfe, 0xff, 0x00, 0x3c, 0x00, 0xe9]);
    });

    for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
        it(`reads back what it writes in ${encoding}`, function () {
            const bytes = textCodec.encode(text, encoding);

            expect(textCodec.encodingOf(bytes)).to.equal(encoding);
            expect(textCodec.decode(bytes, encoding)).to.equal(text);
        });
    }
});
