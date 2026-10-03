import { expect } from "chai";
import crypto from "crypto";
import { GlyfReconstructor } from "app/font-convertor/validator/woff2/glyf-reconstructor";
import type { GlyfParts } from "test/font-convertor/validator/woff2/woff2-font-validator.helper";
import {
    composite,
    concat,
    GLYF_INDEX_FORMAT,
    GLYF_OPTION_FLAGS,
    joinGlyf,
    parse,
    readFixture,
    readUint32,
    splitGlyf,
    tableOf,
    withBoundingBoxBit,
    withBytes,
    withComposite,
    withStream,
    withUint16,
} from "test/font-convertor/validator/woff2/woff2-font-validator.helper";

// The reconstructor reads no file: the path only goes into its answers.
const FONT_PATH = "font.woff2";

// What woff2_decompress 1.0.2, the decoder fontforge links, rebuilds the fixture's glyf and loca into.
const REFERENCE_GLYF_SHA256 = "08063e8e5e14f0865a6624086968d028ae849397385195f97a96995b438a04e9";
const REFERENCE_LOCA_SHA256 = "7d0892d2bbbea67a1ae635c09936ee37d9b317ce2dce043049a3feb5624e0b81";
const REFERENCE_GLYF_SIZE_BYTES = 133392;
// The first glyph of the fixture has 5 contours and no instructions: its first flag follows the
// 10-byte header, 5 end points and instructionLength.
const GLYPH_0_FIRST_FLAG_OFFSET = 22;
// 4 × ⌊(1296 + 31) / 32⌋ bytes.
const BITMAP_SIZE_BYTES = 164;

describe("GlyfReconstructor.reconstruct", function () {
    let glyf: Uint8Array;
    let hmtx: Uint8Array;
    let parts: GlyfParts;

    before(async function () {
        const layout = parse(await readFixture());

        glyf = tableOf(layout, "glyf");
        hmtx = tableOf(layout, "hmtx");
        parts = splitGlyf(glyf);
    });

    function reconstruct(edit: (whole: GlyfParts) => GlyfParts): { glyf: Uint8Array; loca: Uint8Array } {
        return new GlyfReconstructor(FONT_PATH, joinGlyf(edit(parts))).reconstruct(undefined);
    }

    it("rebuilds glyf and loca of the fixture byte for byte as woff2_decompress 1.0.2 does", function () {
        const reconstructed = new GlyfReconstructor(FONT_PATH, glyf).reconstruct(undefined);

        expect(sha256(reconstructed.glyf)).to.equal(REFERENCE_GLYF_SHA256);
        expect(sha256(reconstructed.loca)).to.equal(REFERENCE_LOCA_SHA256);
        expect(reconstructed.hmtx).to.equal(undefined);
    });

    it("writes the explicit bounding box of a simple glyph in place of the one its points give", function () {
        const boundingBox = Uint8Array.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04]);
        const withBox = reconstruct((whole) =>
            withStream(withBoundingBoxBit(whole, 0, true), "bbox", (stream) =>
                concat(stream.subarray(0, BITMAP_SIZE_BYTES), boundingBox, stream.subarray(BITMAP_SIZE_BYTES)),
            ),
        );
        const plain = reconstruct((whole) => whole);

        expect(withBox.glyf.subarray(2, 10)).to.deep.equal(boundingBox);
        expect(withBox.glyf.subarray(10)).to.deep.equal(plain.glyf.subarray(10));
    });

    it("sets OVERLAP_SIMPLE on the first flag of a simple glyph whose bit is set in overlapSimpleBitmap", function () {
        // Bits for glyph 0, simple, and glyph 1, empty: only glyph 0 changes. Its first two flags
        // are equal, 0x21, and written as 0x29 with a repeat count of 1; OVERLAP_SIMPLE on the first
        // sets them apart: 0x61, then 0x21.
        const bitmap = new Uint8Array(BITMAP_SIZE_BYTES);

        bitmap[0] = 0b11000000;

        const withOverlap = reconstruct((whole) => ({ ...whole, header: withUint16(whole.header, GLYF_OPTION_FLAGS, 1), tail: bitmap }));
        const plain = reconstruct((whole) => whole);

        expect(plain.glyf.subarray(GLYPH_0_FIRST_FLAG_OFFSET, GLYPH_0_FIRST_FLAG_OFFSET + 2)).to.deep.equal(Uint8Array.from([0x29, 0x01]));
        expect(withOverlap.glyf).to.deep.equal(withBytes(plain.glyf, GLYPH_0_FIRST_FLAG_OFFSET, [0x61, 0x21]));
    });

    it("copies the components of a composite glyph after its bounding box, padded to 4 bytes", function () {
        const { components, boundingBox = new Uint8Array(0) } = composite();
        const reconstructed = reconstruct((whole) => withComposite(whole, composite()));
        const record = concat(Uint8Array.from([0xff, 0xff]), boundingBox, components, new Uint8Array(2));

        expect(reconstructed.glyf.subarray(REFERENCE_GLYF_SIZE_BYTES)).to.deep.equal(record);
        expect(readUint32(reconstructed.loca, 4 * 1296)).to.equal(REFERENCE_GLYF_SIZE_BYTES);
        expect(readUint32(reconstructed.loca, 4 * 1297)).to.equal(REFERENCE_GLYF_SIZE_BYTES + record.length);
    });

    it("adds instructionLength and the instructions to a composite glyph whose component calls for them", function () {
        // A byte below 253 is the length; 253 a word follows; 255 and 254 a byte that adds 253 or 506.
        const lengths: Array<[Array<number>, number]> = [
            [[17], 17],
            [[253, 0x01, 0x2c], 300],
            [[255, 7], 260],
            [[254, 4], 510],
        ];
        // WE_HAVE_INSTRUCTIONS, ARGS_ARE_XY_VALUES; glyph 5; dx 0, dy 0.
        const components = Uint8Array.from([0x01, 0x02, 0x00, 0x05, 0x00, 0x00]);
        const { boundingBox = new Uint8Array(0) } = composite();

        for (const [encoding, length] of lengths) {
            const instructions = Uint8Array.from({ length: length }, (_, index) => index % 256);
            const reconstructed = reconstruct((whole) =>
                withComposite(whole, {
                    components: components,
                    boundingBox: boundingBox,
                    instructionLength: Uint8Array.from(encoding),
                    instructions: instructions,
                }),
            );
            const record = concat(
                Uint8Array.from([0xff, 0xff]),
                boundingBox,
                components,
                Uint8Array.from([length >> 8, length & 0xff]),
                instructions,
            );

            expect(reconstructed.glyf.subarray(REFERENCE_GLYF_SIZE_BYTES, REFERENCE_GLYF_SIZE_BYTES + record.length)).to.deep.equal(record);
        }
    });

    it("writes loca in the short format, the offsets halved, when indexFormat is 0", function () {
        const long = reconstruct((whole) => whole).loca;
        const short = reconstruct((whole) => ({ ...whole, header: withUint16(whole.header, GLYF_INDEX_FORMAT, 0) })).loca;
        const longOffsets = Array.from({ length: long.length / 4 }, (_, glyph) => readUint32(long, 4 * glyph));
        const shortOffsets = Array.from({ length: short.length / 2 }, (_, glyph) =>
            new DataView(short.buffer, short.byteOffset).getUint16(2 * glyph),
        );

        // The fixture's glyf is over 128 KiB: its last offsets do not fit in 16 bits and wrap, as in the decoder.
        expect(shortOffsets).to.deep.equal(longOffsets.map((offset) => (offset / 2) % 65536));
    });

    describe("rebuilds hmtx from the advance widths and the xMin of the glyphs", function () {
        // The lsb of every glyph of the fixture equal its xMin, so the fixture's own hmtx is what any
        // flags rebuild; a stored lsb is set 1 off it to tell which source a value came from.
        it("for flags 1 and 3, all the glyphs proportional", function () {
            for (const flags of [0x01, 0x03]) {
                const transformed = concat(Uint8Array.from([flags]), ...metrics(hmtx).map((metric) => metric.subarray(0, 2)));
                const reconstructed = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({ bytes: transformed, numberOfHMetrics: 1296 });

                expect(reconstructed.hmtx).to.deep.equal(hmtx);
            }
        });

        it("taking each array of lsb from the table unless its flag drops it", function () {
            const numberOfHMetrics = 1000;
            const proportional = metrics(hmtx).slice(0, numberOfHMetrics);
            const monospaced = metrics(hmtx).slice(numberOfHMetrics);
            const advanceWidths = proportional.map((metric) => metric.subarray(0, 2));
            const offLsbs = (all: Array<Uint8Array>): Array<Uint8Array> => all.map((metric) => offByOne(metric.subarray(2, 4)));
            const xMinLsbs = (all: Array<Uint8Array>): Array<Uint8Array> => all.map((metric) => metric.subarray(2, 4));
            const rebuild = (flags: number, stored: Array<Uint8Array>): Uint8Array | undefined =>
                new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                    bytes: concat(Uint8Array.from([flags]), ...advanceWidths, ...stored),
                    numberOfHMetrics: numberOfHMetrics,
                }).hmtx;
            const expected = (lsbs: Array<Uint8Array>, leftSideBearings: Array<Uint8Array>): Uint8Array =>
                concat(
                    ...advanceWidths.flatMap((advanceWidth, glyph) => [advanceWidth, lsbs[glyph] ?? new Uint8Array(0)]),
                    ...leftSideBearings,
                );

            expect(rebuild(0x02, offLsbs(proportional))).to.deep.equal(expected(offLsbs(proportional), xMinLsbs(monospaced)));
            expect(rebuild(0x01, offLsbs(monospaced))).to.deep.equal(expected(xMinLsbs(proportional), offLsbs(monospaced)));
            expect(rebuild(0x03, [])).to.deep.equal(expected(xMinLsbs(proportional), xMinLsbs(monospaced)));
        });

        it("taking 0 for the lsb of an empty glyph", function () {
            // Glyph 1 is empty; its lsb in the fixture is 0 as well, so a stored lsb of 5 is replaced by 0.
            const stored = metrics(hmtx).map((metric, glyph) => (glyph === 1 ? Uint8Array.from([0x00, 0x05]) : metric.subarray(2, 4)));
            const advanceWidths = metrics(hmtx).map((metric) => metric.subarray(0, 2));
            const fromTable = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                bytes: concat(Uint8Array.from([0x02]), ...advanceWidths, ...stored),
                numberOfHMetrics: 1296,
            });
            const fromXMin = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                bytes: concat(Uint8Array.from([0x01]), ...advanceWidths),
                numberOfHMetrics: 1296,
            });

            expect(fromTable.hmtx?.subarray(6, 8)).to.deep.equal(Uint8Array.from([0x00, 0x05]));
            expect(fromXMin.hmtx?.subarray(6, 8)).to.deep.equal(Uint8Array.from([0x00, 0x00]));
        });
    });
});

function metrics(hmtx: Uint8Array): Array<Uint8Array> {
    return Array.from({ length: hmtx.length / 4 }, (_, glyph) => hmtx.subarray(glyph * 4, glyph * 4 + 4));
}

/**
 * An Int16 one more than `value`.
 */
function offByOne(value: Uint8Array): Uint8Array {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(2);

    new DataView(copy.buffer).setInt16(0, view.getInt16(0) + 1);

    return copy;
}

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}
