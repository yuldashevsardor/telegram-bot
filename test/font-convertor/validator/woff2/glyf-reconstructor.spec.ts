import { expect } from "chai";
import crypto from "crypto";
import { GlyfReconstructor } from "app/font-convertor/validator/woff2/glyf-reconstructor";
import { BrokenWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import type { GlyfParts, GlyfStream } from "test/font-convertor/validator/woff2/woff2-font-validator.helper";
import {
    composite,
    concat,
    FIXTURE_NUM_GLYPHS,
    GLYF_INDEX_FORMAT,
    GLYF_N_CONTOUR_STREAM_SIZE,
    GLYF_NUM_GLYPHS,
    HHEA_NUMBER_OF_H_METRICS,
    GLYF_OPTION_FLAGS,
    joinGlyf,
    NUM_GLYPHS_WITH_COMPOSITE,
    parse,
    readFixture,
    readUint32,
    splitGlyf,
    tableOf,
    withBoundingBoxBitSet,
    withBytes,
    withComposite,
    withStream,
    withUint16,
} from "test/font-convertor/validator/woff2/woff2-font-validator.helper";

// The reconstructor reads no file: the path only goes into its answers.
const FONT_PATH = "font.woff2";

// What woff2_decompress 1.0.2 rebuilds the fixture's glyf and loca into: the command-line tool of
// libwoff2dec, the decoder fontforge links.
const REFERENCE_GLYF_SHA256 = "08063e8e5e14f0865a6624086968d028ae849397385195f97a96995b438a04e9";
const REFERENCE_LOCA_SHA256 = "7d0892d2bbbea67a1ae635c09936ee37d9b317ce2dce043049a3feb5624e0b81";
const REFERENCE_GLYF_SIZE_BYTES = 133392;
// The first glyph of the fixture has 5 contours and no instructions: its first flag follows the
// 10-byte header, 5 end points and instructionLength.
const GLYPH_0_FIRST_FLAG_OFFSET = 22;
// 4 × ⌊(1296 + 31) / 32⌋ bytes.
const BBOX_BITMAP_SIZE_BYTES = 164;
// ⌈1296 / 8⌉ bytes: overlapSimpleBitmap is not padded to words.
const OVERLAP_BITMAP_SIZE_BYTES = 162;
// A glyph of one contour whose x passes 2³¹ − 1 at its last point: 32 768 points of dx = 65 535, a
// point of dx = 32 668 that leaves x 100 short of 2³¹, then a point of dx = 200 that wraps it.
const FULL_STEP_COUNT = 32768;
const FULL_STEP_DX = 0xffff;
const NEAR_LIMIT_DX = 32668;
const WRAPPING_DX = 200;
const WRAPPING_POINT_COUNT = FULL_STEP_COUNT + 2;
const UINT16_SIZE_BYTES = 2;
const FOUR_BYTE_TRIPLET_SIZE_BYTES = 4;
// §5.2 flags: 127 is a dx and a dy of 16 bits each, both positive; 11 is a positive dx of one byte alone.
const FOUR_BYTE_TRIPLET_FLAG = 127;
const DX_ONLY_FLAG = 11;
// The 255UInt16 code that says a UInt16 follows (§3.1).
const WORD_CODE = 253;
// numberOfContours, the bounding box, one end point and instructionLength.
const SIMPLE_GLYPH_HEADER_SIZE_BYTES = 14;
// In the rebuilt glyf the flags take 128 runs of 256 points, each a flag and a repeat count, and then
// the flag of the 32 769th point; the flag of the last point follows.
const LAST_RUN_FLAG_OFFSET_BYTES = SIMPLE_GLYPH_HEADER_SIZE_BYTES + 2 * (FULL_STEP_COUNT / 256);
// On-curve and y the same as before, which the dx of 16 bits leaves alone.
const WORD_DX_FLAG = 0x21;
// On-curve, y the same, x a short vector, positive.
const SHORT_DX_FLAG = 0x33;

// Two simple glyphs of one point each, to lay out a glyf of a size the spec chooses. A record is 16
// bytes and its instructions, padded to 4: the 10-byte header, an end point, instructionLength, a
// flag and one x byte. The first takes 65 535 bytes of instructions, the most instructionLength
// holds, so 65 552 bytes; the second's 65 500 make 65 516 and the glyf 131 068 bytes, the largest
// the short loca holds in 4-byte records; 65 504 make 131 072.
const MAX_INSTRUCTION_LENGTH_BYTES = 0xffff;
const FITTING_INSTRUCTION_LENGTH_BYTES = 65500;
const OVERFLOWING_INSTRUCTION_LENGTH_BYTES = 65504;
const FITTING_GLYF_SIZE_BYTES = 131068;
const OVERFLOWING_GLYF_SIZE_BYTES = 131072;
const MAX_SHORT_LOCA_GLYF_SIZE_BYTES = 131070;
const FIRST_GLYPH_SIZE_BYTES = 65552;
const TWO_GLYPHS_BBOX_BITMAP_SIZE_BYTES = 4;
const LONG_LOCA_FORMAT = 1;
const SHORT_LOCA_FORMAT = 0;
// A bboxBitmap of one glyph is one 32-bit word; its first bit, the most significant of the first
// byte, is that of glyph 0.
const ONE_GLYPH_BBOX_BITMAP_SET = Uint8Array.from([0x80, 0x00, 0x00, 0x00]);
const ONE_GLYPH_BBOX_BITMAP_CLEAR = new Uint8Array(4);
const EXPLICIT_BOUNDING_BOX = Uint8Array.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04]);
// The most glyphs a bboxBitmap of one 32-bit word holds.
const ONE_WORD_BITMAP_GLYPH_COUNT = 32;
// §5.2 flag 124 is the first of the four-byte triplets; bits 0 and 1 of it are clear: a negative dx
// and dy. The bytes 0x01 0x02 and 0x03 0x04 are 258 and 772.
const FIRST_FOUR_BYTE_TRIPLET_FLAG = 124;
// numberOfContours and the 8 bytes of the bounding box.
const BOUNDING_BOX_END_BYTES = 10;
// A transformed hmtx of 1296 glyphs that keeps one word per glyph: the flags byte and 1296 words, a byte short.
const SHORT_HMTX_SIZE_BYTES = 1 + 2 * FIXTURE_NUM_GLYPHS - 1;

describe("GlyfReconstructor.reconstruct", function () {
    let glyf: Uint8Array;
    let hmtx: Uint8Array;
    let hhea: Uint8Array;
    let parts: GlyfParts;

    before(async function () {
        const layout = parse(await readFixture());

        glyf = tableOf(layout, "glyf");
        hmtx = tableOf(layout, "hmtx");
        hhea = tableOf(layout, "hhea");
        parts = splitGlyf(glyf);
    });

    function rebuild(secondInstructionLengthBytes: number, indexFormat: number): { glyf: Uint8Array; loca: Uint8Array } {
        const instructionLengths = [MAX_INSTRUCTION_LENGTH_BYTES, secondInstructionLengthBytes];
        const glyphStream = concat(
            ...instructionLengths.map((lengthBytes) => Uint8Array.from([1, WORD_CODE, lengthBytes >> 8, lengthBytes & 0xff])),
        );
        const header = withUint16(
            withUint16(new Uint8Array(GLYF_N_CONTOUR_STREAM_SIZE), GLYF_NUM_GLYPHS, 2),
            GLYF_INDEX_FORMAT,
            indexFormat,
        );
        const twoGlyphs: GlyfParts = {
            header: header,
            streams: {
                ...parts.streams,
                nContour: Uint8Array.from([0x00, 0x01, 0x00, 0x01]),
                nPoints: Uint8Array.from([1, 1]),
                flag: Uint8Array.from([DX_ONLY_FLAG, DX_ONLY_FLAG]),
                glyph: glyphStream,
                composite: new Uint8Array(0),
                bbox: new Uint8Array(TWO_GLYPHS_BBOX_BITMAP_SIZE_BYTES),
                instruction: new Uint8Array(MAX_INSTRUCTION_LENGTH_BYTES + secondInstructionLengthBytes),
            },
            tail: new Uint8Array(0),
        };

        return new GlyfReconstructor(FONT_PATH, joinGlyf(twoGlyphs)).reconstruct(undefined);
    }

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
            withStream(withBoundingBoxBitSet(whole, 0), "bbox", (stream) =>
                concat(stream.subarray(0, BBOX_BITMAP_SIZE_BYTES), boundingBox, stream.subarray(BBOX_BITMAP_SIZE_BYTES)),
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
        const bitmap = new Uint8Array(OVERLAP_BITMAP_SIZE_BYTES);

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
        expect(readUint32(reconstructed.loca, 4 * FIXTURE_NUM_GLYPHS)).to.equal(REFERENCE_GLYF_SIZE_BYTES);
        expect(readUint32(reconstructed.loca, 4 * NUM_GLYPHS_WITH_COMPOSITE)).to.equal(REFERENCE_GLYF_SIZE_BYTES + record.length);
    });

    it("wraps coordinates and the differences between them at 2³¹, as the C ints of the decoder do", function () {
        // The last point wraps to a negative x, so xMin is its low 16 bits, 100, not the 65 535 of the
        // first point, and its difference from the point before is +200: a short vector, not a word.
        const glyphStream = new Uint8Array((FULL_STEP_COUNT + 1) * FOUR_BYTE_TRIPLET_SIZE_BYTES + 1 + 1);
        const nearLimitOffsetBytes = FULL_STEP_COUNT * FOUR_BYTE_TRIPLET_SIZE_BYTES;

        for (let point = 0; point < FULL_STEP_COUNT; point++) {
            glyphStream.set([FULL_STEP_DX >> 8, FULL_STEP_DX & 0xff], point * FOUR_BYTE_TRIPLET_SIZE_BYTES);
        }

        glyphStream.set([NEAR_LIMIT_DX >> 8, NEAR_LIMIT_DX & 0xff], nearLimitOffsetBytes);
        glyphStream.set([WRAPPING_DX], nearLimitOffsetBytes + FOUR_BYTE_TRIPLET_SIZE_BYTES);

        const { streams } = splitGlyf(glyf);
        const flags = new Uint8Array(WRAPPING_POINT_COUNT).fill(FOUR_BYTE_TRIPLET_FLAG);

        flags[WRAPPING_POINT_COUNT - 1] = DX_ONLY_FLAG;

        const wrapping: GlyfParts = {
            header: withUint16(withUint16(new Uint8Array(GLYF_N_CONTOUR_STREAM_SIZE), GLYF_NUM_GLYPHS, 1), GLYF_INDEX_FORMAT, 1),
            streams: {
                ...streams,
                nContour: Uint8Array.from([0x00, 0x01]),
                nPoints: Uint8Array.from([WORD_CODE, WRAPPING_POINT_COUNT >> 8, WRAPPING_POINT_COUNT & 0xff]),
                flag: flags,
                glyph: glyphStream,
                composite: new Uint8Array(0),
                bbox: new Uint8Array(FOUR_BYTE_TRIPLET_SIZE_BYTES),
                instruction: new Uint8Array(0),
            },
            tail: new Uint8Array(0),
        };
        const reconstructed = new GlyfReconstructor(FONT_PATH, joinGlyf(wrapping)).reconstruct(undefined).glyf;

        expect(reconstructed.subarray(UINT16_SIZE_BYTES, 2 * UINT16_SIZE_BYTES)).to.deep.equal(Uint8Array.from([0x00, 0x64]));
        expect(reconstructed.subarray(LAST_RUN_FLAG_OFFSET_BYTES, LAST_RUN_FLAG_OFFSET_BYTES + 2)).to.deep.equal(
            Uint8Array.from([WORD_DX_FLAG, SHORT_DX_FLAG]),
        );
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
        const longOffsets = locaOffsets(rebuild(FITTING_INSTRUCTION_LENGTH_BYTES, LONG_LOCA_FORMAT).loca, 4);
        const shortOffsets = locaOffsets(rebuild(FITTING_INSTRUCTION_LENGTH_BYTES, SHORT_LOCA_FORMAT).loca, 2);

        expect(longOffsets).to.deep.equal([0, FIRST_GLYPH_SIZE_BYTES, FITTING_GLYF_SIZE_BYTES]);
        expect(shortOffsets).to.deep.equal(longOffsets.map((offset) => offset / 2));
    });

    it("rejects a glyf that a short loca cannot address, which the decoder wraps into wrong offsets", function () {
        expect(rebuild(FITTING_INSTRUCTION_LENGTH_BYTES, SHORT_LOCA_FORMAT).glyf).to.have.lengthOf(FITTING_GLYF_SIZE_BYTES);
        expect(() => rebuild(OVERFLOWING_INSTRUCTION_LENGTH_BYTES, SHORT_LOCA_FORMAT)).to.throw(
            BrokenWoff2,
            `At table "glyf": rebuilt length is ${OVERFLOWING_GLYF_SIZE_BYTES}, expected at most ${MAX_SHORT_LOCA_GLYF_SIZE_BYTES}, as indexFormat is 0.`,
        );
    });

    it("rebuilds a glyf over 131 070 bytes when indexFormat is 1", function () {
        const reconstructed = rebuild(OVERFLOWING_INSTRUCTION_LENGTH_BYTES, LONG_LOCA_FORMAT);

        expect(reconstructed.glyf).to.have.lengthOf(OVERFLOWING_GLYF_SIZE_BYTES);
        expect(locaOffsets(reconstructed.loca, 4)).to.deep.equal([0, FIRST_GLYPH_SIZE_BYTES, OVERFLOWING_GLYF_SIZE_BYTES]);
    });

    it("rebuilds a bboxBitmap of 32 glyphs as one word, not two", function () {
        // ⌊(32 + 31) / 32⌋ = 1 word of 4 bytes: a bboxStream of just that word holds the bitmap.
        const emptyGlyphs = glyfOf(ONE_WORD_BITMAP_GLYPH_COUNT, {
            nContour: new Uint8Array(ONE_WORD_BITMAP_GLYPH_COUNT * UINT16_SIZE_BYTES),
            bbox: ONE_GLYPH_BBOX_BITMAP_CLEAR,
        });
        const reconstructed = new GlyfReconstructor(FONT_PATH, emptyGlyphs).reconstruct(undefined);

        expect(reconstructed.glyf).to.have.lengthOf(0);
        expect(reconstructed.loca).to.deep.equal(new Uint8Array((ONE_WORD_BITMAP_GLYPH_COUNT + 1) * FOUR_BYTE_TRIPLET_SIZE_BYTES));
    });

    it("decodes flag 124 as a dx and a dy of 16 bits each in four bytes", function () {
        // One simple glyph of one point: dx = -(0x0102), dy = -(0x0304); instructionLength 0 follows.
        const glyph = glyfOf(1, {
            nContour: Uint8Array.from([0x00, 0x01]),
            nPoints: Uint8Array.from([1]),
            flag: Uint8Array.from([FIRST_FOUR_BYTE_TRIPLET_FLAG]),
            glyph: Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x00]),
            bbox: ONE_GLYPH_BBOX_BITMAP_CLEAR,
        });
        const reconstructed = new GlyfReconstructor(FONT_PATH, glyph).reconstruct(undefined);

        // xMin, yMin, xMax and yMax of the only point: x −258 = 0xfefe, y −772 = 0xfcfc.
        expect(reconstructed.glyf.subarray(UINT16_SIZE_BYTES, BOUNDING_BOX_END_BYTES)).to.deep.equal(
            Uint8Array.from([0xfe, 0xfe, 0xfc, 0xfc, 0xfe, 0xfe, 0xfc, 0xfc]),
        );
    });

    describe("names the substream and what it was read for when a glyph record runs past it", function () {
        const simpleGlyph = {
            nContour: Uint8Array.from([0x00, 0x01]),
            nPoints: Uint8Array.from([1]),
            flag: Uint8Array.from([DX_ONLY_FLAG]),
        };
        // WE_HAVE_INSTRUCTIONS, ARGS_ARE_XY_VALUES; glyph 5; dx 0, dy 0.
        const instructedComponent = Uint8Array.from([0x01, 0x02, 0x00, 0x05, 0x00, 0x00]);
        const compositeNContour = Uint8Array.from([0xff, 0xff]);

        function expectBroken(streams: Partial<Record<GlyfStream, Uint8Array>>, message: string): void {
            expect(() => new GlyfReconstructor(FONT_PATH, glyfOf(1, streams)).reconstruct(undefined)).to.throw(
                BrokenWoff2,
                `At glyph 0 of table "glyf": ${message}`,
            );
        }

        it("for the instructionLength of a simple glyph", function () {
            expectBroken(
                { ...simpleGlyph, glyph: Uint8Array.from([5]), bbox: ONE_GLYPH_BBOX_BITMAP_CLEAR },
                "bytes left in glyphStream is 0, expected at least 1, for instructionLength.",
            );
        });

        it("for the flags of a component", function () {
            expectBroken(
                { nContour: compositeNContour, bbox: ONE_GLYPH_BBOX_BITMAP_SET },
                "bytes left in compositeStream is 0, expected at least 2, for the flags of component 1.",
            );
        });

        it("for the bounding box of a composite glyph", function () {
            expectBroken(
                { nContour: compositeNContour, composite: instructedComponent, bbox: ONE_GLYPH_BBOX_BITMAP_SET },
                "bytes left in bboxStream is 0, expected at least 8, for the bounding box.",
            );
        });

        it("for the instructionLength of a composite glyph", function () {
            expectBroken(
                {
                    nContour: compositeNContour,
                    composite: instructedComponent,
                    bbox: concat(ONE_GLYPH_BBOX_BITMAP_SET, EXPLICIT_BOUNDING_BOX),
                },
                "bytes left in glyphStream is 0, expected at least 1, for instructionLength.",
            );
        });
    });

    describe("rebuilds hmtx from the advance widths and the xMin of the glyphs", function () {
        // The lsb of every glyph of the fixture equal its xMin, so the fixture's own hmtx is what any
        // flags rebuild; a stored lsb is set 1 off it to tell which source a value came from.
        it("for flags 1 and 3, all the glyphs proportional", function () {
            for (const flags of [0x01, 0x03]) {
                const transformed = concat(Uint8Array.from([flags]), ...metrics(hmtx).map((metric) => metric.subarray(0, 2)));
                const reconstructed = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({ bytes: transformed, hhea: hhea });

                expect(reconstructed.hmtx).to.deep.equal(hmtx);
            }
        });

        it("for a single proportional glyph, numberOfHMetrics 1", function () {
            const [firstMetric = new Uint8Array(0)] = metrics(hmtx);
            const advanceWidth = firstMetric.subarray(0, 2);
            const reconstructed = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                bytes: concat(Uint8Array.from([0x03]), advanceWidth),
                hhea: withUint16(hhea, HHEA_NUMBER_OF_H_METRICS, 1),
            });

            expect(reconstructed.hmtx).to.deep.equal(concat(advanceWidth, ...metrics(hmtx).map((metric) => metric.subarray(2, 4))));
        });

        it("rejecting a table too short for the lsb of its monospaced glyphs", function () {
            // Flags 1 drop lsb[] of the 1000 proportional glyphs and keep leftSideBearing[] of the other 296.
            const shortHmtx = new Uint8Array(SHORT_HMTX_SIZE_BYTES);

            shortHmtx[0] = 0x01;

            expect(() =>
                new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                    bytes: shortHmtx,
                    hhea: withUint16(hhea, HHEA_NUMBER_OF_H_METRICS, 1000),
                }),
            ).to.throw(
                BrokenWoff2,
                `At table "hmtx": transformLength is ${SHORT_HMTX_SIZE_BYTES}, expected at least ${
                    SHORT_HMTX_SIZE_BYTES + 1
                }, for flags 1 and numberOfHMetrics 1000.`,
            );
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
                    hhea: withUint16(hhea, HHEA_NUMBER_OF_H_METRICS, numberOfHMetrics),
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

        it("taking the xMin of the bounding box of a composite glyph", function () {
            // woff2_decompress 1.0.2 writes 10 here too: its nContour is a UInt16, and −1 passes its
            // n_contours > 0. Glyph 1296 is the composite, a monospaced glyph after 1296 hMetrics.
            const advanceWidths = metrics(hmtx).map((metric) => metric.subarray(0, 2));
            const reconstructed = new GlyfReconstructor(FONT_PATH, joinGlyf(withComposite(parts, composite()))).reconstruct({
                bytes: concat(Uint8Array.from([0x03]), ...advanceWidths),
                hhea: hhea,
            });

            expect(reconstructed.hmtx).to.deep.equal(concat(hmtx, Uint8Array.from([0x00, 0x0a])));
        });

        it("taking 0 for the lsb of an empty glyph", function () {
            // Glyph 1 is empty. A stored lsb of 5 is kept while lsb[] is in the table; with lsb[]
            // dropped, the lsb is rebuilt as 0.
            const stored = metrics(hmtx).map((metric, glyph) => (glyph === 1 ? Uint8Array.from([0x00, 0x05]) : metric.subarray(2, 4)));
            const advanceWidths = metrics(hmtx).map((metric) => metric.subarray(0, 2));
            const fromTable = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                bytes: concat(Uint8Array.from([0x02]), ...advanceWidths, ...stored),
                hhea: hhea,
            });
            const fromXMin = new GlyfReconstructor(FONT_PATH, glyf).reconstruct({
                bytes: concat(Uint8Array.from([0x01]), ...advanceWidths),
                hhea: hhea,
            });

            expect(fromTable.hmtx?.subarray(6, 8)).to.deep.equal(Uint8Array.from([0x00, 0x05]));
            expect(fromXMin.hmtx?.subarray(6, 8)).to.deep.equal(Uint8Array.from([0x00, 0x00]));
        });
    });
});

const EMPTY_STREAMS: Record<GlyfStream, Uint8Array> = {
    nContour: new Uint8Array(0),
    nPoints: new Uint8Array(0),
    flag: new Uint8Array(0),
    glyph: new Uint8Array(0),
    composite: new Uint8Array(0),
    bbox: new Uint8Array(0),
    instruction: new Uint8Array(0),
};

/**
 * A transformed glyf of `numGlyphs` glyphs whose substreams are the given ones, the rest empty, with the long loca.
 */
function glyfOf(numGlyphs: number, streams: Partial<Record<GlyfStream, Uint8Array>>): Uint8Array {
    const header = withUint16(
        withUint16(new Uint8Array(GLYF_N_CONTOUR_STREAM_SIZE), GLYF_NUM_GLYPHS, numGlyphs),
        GLYF_INDEX_FORMAT,
        LONG_LOCA_FORMAT,
    );

    return joinGlyf({ header: header, streams: { ...EMPTY_STREAMS, ...streams }, tail: new Uint8Array(0) });
}

function locaOffsets(loca: Uint8Array, offsetSizeBytes: number): Array<number> {
    const view = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);

    return Array.from({ length: loca.length / offsetSizeBytes }, (_, glyph) =>
        offsetSizeBytes === 2 ? view.getUint16(2 * glyph) : view.getUint32(4 * glyph),
    );
}

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
