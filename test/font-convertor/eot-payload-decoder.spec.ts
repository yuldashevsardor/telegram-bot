import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { EotError } from "mtx-decompressor";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { InvalidEotPayload } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder.errors";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { fontDataOf, overwritten, xor } from "test/font-convertor/eot-payload-decoder.helper";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The flags of the header (EOT, §4.2). The spec keeps its own copies rather than the constants of
// EotHeader, so that a wrong constant in the class fails its spec.
const TTEMBED_SUBSET = 0x00000001;
const TTEMBED_TTCOMPRESSED = 0x00000004;
const TTEMBED_XORENCRYPTDATA = 0x10000000;

const decoder = new EotPayloadDecoder();

describe("EotPayloadDecoder.decode", function () {
    let ttf: Uint8Array;
    let plainFontData: Uint8Array;
    let compressedFontData: Uint8Array;

    before(async function () {
        ttf = await readFixture("test-font.ttf");
        plainFontData = fontDataOf(await readFixture("test-font.eot"));
        compressedFontData = fontDataOf(await readFixture("test-font-compressed.eot"));
    });

    it("returns FontData itself without either flag", function () {
        expect(decoder.decode(plainFontData, 0)).to.equal(plainFontData);
        expect(decoder.decode(plainFontData, TTEMBED_SUBSET)).to.equal(plainFontData);
    });

    it("decrypts an encrypted FontData into the font it was made of", function () {
        expect(hex(decoder.decode(xor(plainFontData), TTEMBED_XORENCRYPTDATA))).to.equal(hex(ttf));
    });

    it("decompresses a compressed FontData into an sfnt", function () {
        // The glyphs are compared with the font the fixture was made of in eot-packer.spec.ts.
        new SfntFontValidator().validateBytes("compressed", decoder.decode(compressedFontData, TTEMBED_TTCOMPRESSED));
    });

    it("decrypts a FontData both compressed and encrypted before it decompresses it", function () {
        const decoded = decoder.decode(xor(compressedFontData), TTEMBED_TTCOMPRESSED | TTEMBED_XORENCRYPTDATA);

        expect(hex(decoded)).to.equal(hex(decoder.decode(compressedFontData, TTEMBED_TTCOMPRESSED)));
    });

    describe("rejects a FontData that does not decode under its flags", function () {
        const cases = [
            { name: "compressed data cut in half", fontData: (): Uint8Array => compressedFontData.slice(0, compressedFontData.length / 2) },
            { name: "compressed data with bytes overwritten", fontData: (): Uint8Array => overwritten(compressedFontData) },
            { name: "the compression flag over a plain sfnt", fontData: (): Uint8Array => plainFontData },
        ];

        for (const { name, fontData } of cases) {
            it(name, function () {
                const flags = TTEMBED_TTCOMPRESSED | TTEMBED_SUBSET;
                const error = rejectionOf(() => decoder.decode(fontData(), flags));

                expect(error).to.be.instanceOf(InvalidEotPayload);
                expect(error.message).to.equal("Eot font data cannot be decoded under flags 0x00000005.");
                expect(error.payload).to.deep.equal({ flags: flags });
                expect(error.cause).to.be.instanceOf(EotError);
            });
        }
    });
});

function rejectionOf(call: () => unknown): InvalidEotPayload {
    try {
        call();
    } catch (error) {
        return error as InvalidEotPayload;
    }

    return expect.fail("the call did not throw");
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

async function readFixture(name: string): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, name)));
}
