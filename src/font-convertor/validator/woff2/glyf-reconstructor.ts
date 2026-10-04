import { BrokenWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import type { Violation } from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import { TableTag, Woff2Rule } from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import { NumberHelper } from "app/shared/number-helper";

/**
 * A byte array read from the start, one of the seven substreams of a transformed glyf (§5.1) or the
 * values of a transformed hmtx: `offsetBytes` is where the next read takes its bytes from.
 */
type Substream = {
    /** How the standard and a message name it: `nPointsStream`. */
    name: string;
    bytes: Uint8Array;
    offsetBytes: number;
};

/**
 * A point of a simple glyph, its coordinates the sum of the deltas before it (§5.2).
 */
type Point = {
    x: number;
    y: number;
    isOnCurve: boolean;
};

/**
 * A transformed hmtx that rule `Woff2Rule.TransformedHmtx` holds for, with its flags read: whether lsb[] and
 * leftSideBearing[] are in the table.
 */
type RebuildableHmtx = {
    bytes: Uint8Array;
    numberOfHMetrics: number;
    hasLsb: boolean;
    hasLeftSideBearing: boolean;
};

/**
 * A transformed hmtx (§5.4) with hhea, whose numberOfHMetrics says how many advance widths it
 * holds; hhea is undefined when the font has none.
 */
export type TransformedHmtxWithHhea = {
    bytes: Uint8Array;
    hhea: Uint8Array | undefined;
};

/**
 * What `GlyfReconstructor` rebuilds: glyf and loca, and hmtx when it is transformed.
 */
export type ReconstructedTables = {
    glyf: Uint8Array;
    loca: Uint8Array;
    hmtx: Uint8Array | undefined;
};

/**
 * Rebuilds glyf and loca from a transformed glyf (WOFF 2.0, §5.1–§5.3), and a transformed hmtx
 * from the xMin of the glyphs (§5.4), checking the glyph records as it reads them. One object
 * reads one transformed glyf: it keeps the place it has reached in each substream.
 *
 * §5.1 specifies "the decoded result at the semantic level, not specific byte streams". Where the
 * bytes are open, they are written the way the decoder of fontforge writes them, `ReconstructGlyf()`,
 * `StorePoints()` and `ReconstructTransformedHmtx()` in `woff2_dec.cc` 1.0.2, so that its output is
 * a direct check:
 * - a simple glyph's flag sets on-curve from bit 7 of the WOFF2 flag; for x, and likewise y, a zero
 *   delta sets "same", a delta in −255…255 sets "short", and "same" too when positive, and any
 *   other delta takes a 16-bit word; a flag equal to the one before sets "repeat" on that one and
 *   counts, up to 255 repeats;
 * - all x bytes, then all y bytes;
 * - each glyph record is padded to 4 bytes;
 * - a composite glyph carries an instruction length and instructions only when one of its
 *   component flags has WE_HAVE_INSTRUCTIONS;
 * - the xMin a dropped lsb is rebuilt from is that of the glyph's bounding box, for a composite
 *   glyph as for a simple one, and 0 for an empty glyph. The decoder reads nContour as a UInt16,
 *   so its `n_contours > 0` holds for −1 too; `woff2_decompress` writes 10, the xMin of the
 *   composite of the spec, for its lsb.
 *
 * A contour of 0 points passes, as in the decoder: it ends where the contour before it does, or
 * at −1, written as 0xFFFF, when it is the first. §5.1 sets no bound on it but the 65 536 points
 * of `EndPoint`; `SfntFontValidator` rejects such a glyph once the rebuilt sfnt is handed to it
 * (#737).
 *
 * The OVERLAP_SIMPLE bit the overlapSimpleBitmap gives a simple glyph goes on its first flag, as
 * §5.1 says, before the flag is compared with the next one for "repeat". Decoder 1.0.2 knows
 * nothing of the bitmap, so no output of a decoder was compared with this.
 */
export class GlyfReconstructor {
    // The header of a transformed glyf (§5.1): reserved, optionFlags, numGlyphs, indexFormat, then
    // the sizes of the seven substreams that follow it, one UInt32 each.
    private static readonly HEADER_SIZE_BYTES = 36;
    private static readonly FIELD_OFFSETS_BYTES = { optionFlags: 2, numGlyphs: 4, indexFormat: 6, substreamSizes: 8 };
    private static readonly SUBSTREAM_SIZE_FIELD_BYTES = 4;
    // The substreams in the order of their sizes in the header.
    private static readonly SUBSTREAM_NAMES = [
        "nContourStream",
        "nPointsStream",
        "flagStream",
        "glyphStream",
        "compositeStream",
        "bboxStream",
        "instructionStream",
    ] as const;
    private static readonly OVERLAP_SIMPLE_BITMAP_FLAG = 0x0001;
    // bboxBitmap holds a bit per glyph, padded to whole 32-bit words: 4 × ⌊(numGlyphs + 31) / 32⌋
    // bytes; overlapSimpleBitmap pads only to a byte. Glyph 0 is the most significant bit of the
    // first byte of each.
    private static readonly BITMAP_WORD_SIZE_BITS = 32;
    private static readonly BITMAP_WORD_SIZE_BYTES = 4;
    private static readonly BITS_PER_BYTE = 8;
    private static readonly BYTE_MASK = 0xff;
    private static readonly FIRST_GLYPH_BIT = 0x80;
    private static readonly COMPOSITE_CONTOURS = -1;
    private static readonly EMPTY_CONTOURS = 0;
    // 255UInt16 (§3.1): a byte below 253 is the value; 253 says a UInt16 follows, 255 and 254 say a
    // byte follows that adds 253 or 2 × 253.
    private static readonly WORD_CODE = 253;
    private static readonly ONE_MORE_BYTE_CODE_2 = 254;
    private static readonly ONE_MORE_BYTE_CODE_1 = 255;
    private static readonly ONE_MORE_BYTE_CODE_1_BASE = 253;
    private static readonly ONE_MORE_BYTE_CODE_2_BASE = 2 * GlyfReconstructor.ONE_MORE_BYTE_CODE_1_BASE;
    private static readonly CODE_SIZE_BYTES = 1;
    // The flag of a point in the flag stream (§5.2): bit 7 clear for an on-curve point, bits 0–6
    // the kind of its triplet. The first flag of each kind of triplet, as the table of §5.2 lists
    // them: 0–9 a dy alone, 10–19 a dx alone, 20–83 both in one byte, 84–119 in two, 120–123 in
    // three, 124–127 in four.
    private static readonly OFF_CURVE_BIT = 0x80;
    private static readonly TRIPLET_KIND_BITS = 0x7f;
    private static readonly FIRST_DX_ONLY_FLAG = 10;
    private static readonly FIRST_ONE_BYTE_FLAG = 20;
    private static readonly FIRST_TWO_BYTES_FLAG = 84;
    private static readonly FIRST_THREE_BYTES_FLAG = 120;
    private static readonly FIRST_FOUR_BYTES_FLAG = 124;
    private static readonly ONE_BYTE_TRIPLET_SIZE_BYTES = 1;
    private static readonly TWO_BYTES_TRIPLET_SIZE_BYTES = 2;
    private static readonly THREE_BYTES_TRIPLET_SIZE_BYTES = 3;
    private static readonly FOUR_BYTES_TRIPLET_SIZE_BYTES = 4;
    private static readonly HIGH_BYTE_BITS = 0b1110;
    private static readonly ONE_BYTE_DX_BASE_BITS = 0b110000;
    private static readonly ONE_BYTE_DY_BASE_BITS = 0b1100;
    private static readonly TWO_BYTES_DX_STEP = 12;
    // Bits 0 and 1 of the flag within a range are the signs of dx and dy.
    private static readonly SIGN_BIT_COUNT = 2;
    private static readonly DY_SIGN_SHIFT = 1;
    // withSign() reads the sign from bit 0 of the bits it is given; a set bit is positive.
    private static readonly POSITIVE_SIGN_BIT = 0x01;
    // The flags 0–19 carry bits 1–3 of the flag within the range as bits 8–10 of the magnitude: the
    // bits stay where they are in the mask, and 7 more places take them to their place.
    private static readonly HIGH_BYTE_SHIFT = 7;
    // The magnitude of a one-byte or a two-byte triplet counts from 1 (§5.2).
    private static readonly MAGNITUDE_BIAS = 1;
    private static readonly BITS_PER_NIBBLE = 4;
    private static readonly LOW_NIBBLE = 0x0f;
    // The flags of a simple glyph of glyf (OpenType 1.9.1, glyf).
    private static readonly ON_CURVE_POINT = 0x01;
    private static readonly X_SHORT_VECTOR = 0x02;
    private static readonly Y_SHORT_VECTOR = 0x04;
    private static readonly REPEAT_FLAG = 0x08;
    private static readonly X_IS_SAME_OR_POSITIVE = 0x10;
    private static readonly Y_IS_SAME_OR_POSITIVE = 0x20;
    private static readonly OVERLAP_SIMPLE = 0x40;
    private static readonly MAX_REPEAT_COUNT = 255;
    // A delta of a short vector is one byte of its magnitude: −255…255.
    private static readonly MAX_SHORT_DELTA = 255;
    // The flags of a component of a composite glyph (OpenType 1.9.1, glyf).
    private static readonly ARG_1_AND_2_ARE_WORDS = 0x0001;
    private static readonly WE_HAVE_A_SCALE = 0x0008;
    private static readonly MORE_COMPONENTS = 0x0020;
    private static readonly WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
    private static readonly WE_HAVE_A_TWO_BY_TWO = 0x0080;
    private static readonly WE_HAVE_INSTRUCTIONS = 0x0100;
    // What follows the flags of a component: its glyph index, argument1 and argument2 as words or
    // bytes, then an F2Dot14 scale, an x and a y scale or a 2 × 2 matrix.
    private static readonly GLYPH_INDEX_SIZE_BYTES = 2;
    private static readonly WORD_ARGUMENTS_SIZE_BYTES = 4;
    private static readonly BYTE_ARGUMENTS_SIZE_BYTES = 2;
    private static readonly SCALE_SIZE_BYTES = 2;
    private static readonly X_AND_Y_SCALE_SIZE_BYTES = 4;
    private static readonly TWO_BY_TWO_SIZE_BYTES = 8;
    // A glyph record of glyf: numberOfContours and the bounding box, xMin first, take 10 bytes.
    private static readonly GLYPH_HEADER_SIZE_BYTES = 10;
    private static readonly X_MIN_OFFSET_BYTES = 2;
    private static readonly BOUNDING_BOX_SIZE_BYTES = 8;
    private static readonly MAX_END_POINT = 0xffff;
    private static readonly GLYPH_ALIGNMENT_BYTES = 4;
    // glyf and hmtx hold 16-bit words: endPtsOfContours, instructionLength, the metrics.
    private static readonly WORD_SIZE_BYTES = 2;
    private static readonly SHORT_LOCA_FORMAT = 0;
    private static readonly SHORT_LOCA_OFFSET_SIZE_BYTES = 2;
    private static readonly LONG_LOCA_OFFSET_SIZE_BYTES = 4;
    private static readonly SHORT_LOCA_DIVISOR = 2;
    // The largest offset of the short format: a uint16 of halved offsets.
    private static readonly MAX_SHORT_LOCA_OFFSET_BYTES = 0xffff * GlyfReconstructor.SHORT_LOCA_DIVISOR;
    // The transformed hmtx (§5.4): a flags byte, then UInt16 and Int16 values.
    private static readonly HMTX_FLAGS_SIZE_BYTES = 1;
    // numberOfHMetrics, a UInt16 at offset 34, is the last field of the 36-byte hhea (OpenType 1.9.1, hhea).
    private static readonly NUMBER_OF_H_METRICS_OFFSET_BYTES = 34;
    private static readonly HHEA_MIN_SIZE_BYTES = 36;
    private static readonly MIN_NUMBER_OF_H_METRICS = 1;
    private static readonly NO_LSB_FLAG = 0x01;
    private static readonly NO_LEFT_SIDE_BEARING_FLAG = 0x02;

    public readonly numGlyphs: number;
    public readonly indexFormat: number;
    // An offset of loca takes 2 bytes, the offset halved, when indexFormat is 0, and 4 otherwise (§5.3).
    public readonly locaOffsetSizeBytes: number;
    private readonly nContourStream: Substream;
    private readonly nPointsStream: Substream;
    private readonly flagStream: Substream;
    private readonly glyphStream: Substream;
    private readonly compositeStream: Substream;
    private readonly bboxStream: Substream;
    private readonly instructionStream: Substream;
    private readonly bboxBitmap: Uint8Array;
    private readonly overlapSimpleBitmap: Uint8Array | undefined;
    // The glyph being read: every answer about a glyph record names it.
    private glyphIndex = 0;

    /**
     * Reads the header and cuts the substreams. Throws `BrokenWoff2` when the table is shorter than
     * its header, the substreams run past it, bboxStream is shorter than its bboxBitmap, or the
     * overlapSimpleBitmap bit 0 of optionFlags calls for is not there.
     */
    public constructor(private readonly fontPath: string, transformedGlyf: Uint8Array) {
        const headerSizeBytes = GlyfReconstructor.HEADER_SIZE_BYTES;

        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it differs only on a transformed glyf of the header alone, whose empty substreams hold no glyph, which is not a font
        if (transformedGlyf.length < headerSizeBytes) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "transformLength",
                value: transformedGlyf.length,
                expected: `at least ${headerSizeBytes}, the size of the header`,
            });
        }

        const view = new DataView(transformedGlyf.buffer, transformedGlyf.byteOffset, transformedGlyf.byteLength);
        const fields = GlyfReconstructor.FIELD_OFFSETS_BYTES;
        const substreamsEndBytes = GlyfReconstructor.substreamStartBytes(view, GlyfReconstructor.SUBSTREAM_NAMES.length);

        this.numGlyphs = view.getUint16(fields.numGlyphs);
        this.indexFormat = view.getUint16(fields.indexFormat);
        this.locaOffsetSizeBytes =
            this.indexFormat === GlyfReconstructor.SHORT_LOCA_FORMAT
                ? GlyfReconstructor.SHORT_LOCA_OFFSET_SIZE_BYTES
                : GlyfReconstructor.LONG_LOCA_OFFSET_SIZE_BYTES;
        this.nContourStream = GlyfReconstructor.substream(transformedGlyf, view, "nContourStream");
        this.nPointsStream = GlyfReconstructor.substream(transformedGlyf, view, "nPointsStream");
        this.flagStream = GlyfReconstructor.substream(transformedGlyf, view, "flagStream");
        this.glyphStream = GlyfReconstructor.substream(transformedGlyf, view, "glyphStream");
        this.compositeStream = GlyfReconstructor.substream(transformedGlyf, view, "compositeStream");
        this.bboxStream = GlyfReconstructor.substream(transformedGlyf, view, "bboxStream");
        this.instructionStream = GlyfReconstructor.substream(transformedGlyf, view, "instructionStream");

        if (substreamsEndBytes > transformedGlyf.length) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "end of the substreams",
                value: substreamsEndBytes,
                expected: `at most ${transformedGlyf.length}, the transformLength`,
            });
        }

        if (this.bboxStream.bytes.length < this.bboxBitmapSizeBytes()) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "bboxStreamSize",
                value: this.bboxStream.bytes.length,
                expected: `at least ${this.bboxBitmapSizeBytes()}, the size of bboxBitmap for ${this.numGlyphs} glyphs`,
            });
        }

        // The bounding boxes follow the bitmap in bboxStream.
        this.bboxBitmap = this.bboxStream.bytes.subarray(0, this.bboxBitmapSizeBytes());
        this.bboxStream.offsetBytes = this.bboxBitmapSizeBytes();

        if ((view.getUint16(fields.optionFlags) & GlyfReconstructor.OVERLAP_SIMPLE_BITMAP_FLAG) === 0) {
            return;
        }

        // ⌈numGlyphs / 8⌉ bytes, not padded to 32-bit words: §5.1 pads only bboxBitmap, and fontTools
        // and google/woff2 write this one unpadded.
        const bitmapEndBytes = substreamsEndBytes + Math.ceil(this.numGlyphs / GlyfReconstructor.BITS_PER_BYTE);

        if (bitmapEndBytes > transformedGlyf.length) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "end of overlapSimpleBitmap",
                value: bitmapEndBytes,
                expected: `at most ${transformedGlyf.length}, the transformLength, as bit 0 of optionFlags is set`,
            });
        }

        this.overlapSimpleBitmap = transformedGlyf.subarray(substreamsEndBytes, bitmapEndBytes);
    }

    /**
     * Where substream `index` starts in the transformed glyf: after the header and the substreams
     * before it, which the sizes in the header give. The number of substreams gives the end of the last one.
     */
    private static substreamStartBytes(view: DataView, index: number): number {
        let startBytes = GlyfReconstructor.HEADER_SIZE_BYTES;

        for (let previous = 0; previous < index; previous++) {
            startBytes += view.getUint32(GlyfReconstructor.sizeFieldOffsetBytes(previous));
        }

        return startBytes;
    }

    private static sizeFieldOffsetBytes(index: number): number {
        return GlyfReconstructor.FIELD_OFFSETS_BYTES.substreamSizes + index * GlyfReconstructor.SUBSTREAM_SIZE_FIELD_BYTES;
    }

    private static substream(
        transformedGlyf: Uint8Array,
        view: DataView,
        name: (typeof GlyfReconstructor.SUBSTREAM_NAMES)[number],
    ): Substream {
        const index = GlyfReconstructor.SUBSTREAM_NAMES.indexOf(name);
        const startBytes = GlyfReconstructor.substreamStartBytes(view, index);
        const sizeBytes = view.getUint32(GlyfReconstructor.sizeFieldOffsetBytes(index));

        return { name: name, bytes: transformedGlyf.subarray(startBytes, startBytes + sizeBytes), offsetBytes: 0 };
    }

    /**
     * Reads the glyph records one by one, each taking what it needs from the substreams, and lays
     * them out into glyf with their offsets in loca; then rebuilds `transformedHmtx`, if given, from
     * the xMin of the glyphs. Throws `BrokenWoff2` on a transformed hmtx that hhea and the glyph count
     * do not fit, checked first, or on the first glyph record that cannot be decoded.
     *
     * Called once per object: it goes on from the place each substream has reached, so a second call
     * would read the records of the glyphs from where the first left off.
     */
    public reconstruct(transformedHmtx: TransformedHmtxWithHhea | undefined): ReconstructedTables {
        const rebuildableHmtx = transformedHmtx === undefined ? undefined : this.rebuildableHmtx(transformedHmtx);
        const records: Array<Uint8Array> = [];
        const offsets: Array<number> = [];
        const xMins: Array<number> = [];
        let glyfSizeBytes = 0;

        for (this.glyphIndex = 0; this.glyphIndex < this.numGlyphs; this.glyphIndex++) {
            const record = this.glyphRecord();
            const paddingBytes = NumberHelper.roundUp(record.length, GlyfReconstructor.GLYPH_ALIGNMENT_BYTES) - record.length;

            records.push(record, new Uint8Array(paddingBytes));
            offsets.push(glyfSizeBytes);
            xMins.push(this.xMin(record));
            glyfSizeBytes += record.length + paddingBytes;
        }

        offsets.push(glyfSizeBytes);
        this.checkGlyfFitsLoca(glyfSizeBytes);

        return {
            glyf: Buffer.concat(records),
            loca: this.loca(offsets),
            hmtx: rebuildableHmtx === undefined ? undefined : this.hmtx(rebuildableHmtx, xMins),
        };
    }

    private glyphRecord(): Uint8Array {
        const nContour = this.readInt16(this.nContourStream, "nContour");

        if (nContour === GlyfReconstructor.COMPOSITE_CONTOURS) {
            return this.compositeGlyph();
        }

        if (nContour === GlyfReconstructor.EMPTY_CONTOURS) {
            return this.emptyGlyph();
        }

        if (nContour > 0) {
            return this.simpleGlyph(nContour);
        }

        throw this.brokenGlyph(Woff2Rule.ContourCount, {
            field: "nContour",
            value: nContour,
            expected: "-1, 0 or a positive number",
        });
    }

    /**
     * An empty glyph takes no bytes in glyf: its loca offset equals the next one (§5.1).
     */
    private emptyGlyph(): Uint8Array {
        if (this.hasBoundingBox()) {
            throw this.brokenGlyph(Woff2Rule.EmptyGlyphBoundingBox, {
                field: "bit in bboxBitmap",
                value: 1,
                expected: "0, as nContour is 0",
            });
        }

        return new Uint8Array(0);
    }

    /**
     * The steps of §5.1 for a simple glyph: the points of each contour from nPointsStream, a flag per
     * point from flagStream, its coordinates and then instructionLength from glyphStream, the
     * instructions from instructionStream, and the bounding box from bboxStream or the points.
     */
    private simpleGlyph(nContour: number): Uint8Array {
        const endPoints: Array<number> = [];
        let pointCount = 0;

        for (let contour = 1; contour <= nContour; contour++) {
            pointCount += this.read255UInt16(this.nPointsStream, `the points of contour ${contour}`);

            const endPoint = pointCount - 1;

            if (endPoint > GlyfReconstructor.MAX_END_POINT) {
                throw this.brokenGlyph(Woff2Rule.EndPoint, {
                    field: `end point of contour ${contour}`,
                    value: endPoint,
                    expected: `at most ${GlyfReconstructor.MAX_END_POINT}`,
                });
            }

            endPoints.push(endPoint);
        }

        const flags = this.take(this.flagStream, pointCount, `the flags of ${pointCount} points`);
        const points = this.points(flags);
        const instructionLength = this.read255UInt16(this.glyphStream, "instructionLength");
        const instructions = this.take(this.instructionStream, instructionLength, "the instructions");
        const boundingBox = this.hasBoundingBox()
            ? this.take(this.bboxStream, GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES, "the bounding box")
            : this.boundingBox(points);
        const outline = this.outline(points);

        return Buffer.concat([
            this.glyphHeader(nContour, boundingBox),
            this.words([...endPoints, instructionLength]),
            instructions,
            outline,
        ]);
    }

    /**
     * The steps of §5.1 for a composite glyph: the components from compositeStream as they are, the
     * bounding box from bboxStream, and the instructions when a component flag calls for them.
     */
    private compositeGlyph(): Uint8Array {
        if (!this.hasBoundingBox()) {
            throw this.brokenGlyph(Woff2Rule.CompositeBoundingBox, {
                field: "bit in bboxBitmap",
                value: 0,
                expected: "1, as nContour is -1",
            });
        }

        const componentsStartBytes = this.compositeStream.offsetBytes;
        let hasInstructions = false;
        let component = 0;
        let flags: number;

        do {
            component++;
            flags = this.readUint16(this.compositeStream, `the flags of component ${component}`);
            hasInstructions ||= (flags & GlyfReconstructor.WE_HAVE_INSTRUCTIONS) !== 0;
            this.take(this.compositeStream, this.componentArgumentsSizeBytes(flags), `the arguments of component ${component}`);
        } while ((flags & GlyfReconstructor.MORE_COMPONENTS) !== 0);

        const components = this.compositeStream.bytes.subarray(componentsStartBytes, this.compositeStream.offsetBytes);
        const boundingBox = this.take(this.bboxStream, GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES, "the bounding box");
        const header = this.glyphHeader(GlyfReconstructor.COMPOSITE_CONTOURS, boundingBox);

        if (!hasInstructions) {
            return Buffer.concat([header, components]);
        }

        const instructionLength = this.read255UInt16(this.glyphStream, "instructionLength");
        const instructions = this.take(this.instructionStream, instructionLength, "the instructions");

        return Buffer.concat([header, components, this.words([instructionLength]), instructions]);
    }

    /**
     * numberOfContours and the bounding box: the first 10 bytes of a glyph record of glyf.
     */
    private glyphHeader(nContour: number, boundingBox: Uint8Array): Uint8Array {
        const header = new Uint8Array(GlyfReconstructor.GLYPH_HEADER_SIZE_BYTES);

        new DataView(header.buffer).setInt16(0, nContour);
        header.set(boundingBox, GlyfReconstructor.X_MIN_OFFSET_BYTES);

        return header;
    }

    /**
     * The values as big-endian 16-bit words, as glyf and hmtx hold them. A negative value is written
     * in two's complement.
     */
    private words(values: Array<number>): Uint8Array {
        const bytes = new Uint8Array(values.length * GlyfReconstructor.WORD_SIZE_BYTES);
        const view = new DataView(bytes.buffer);

        for (const [index, value] of values.entries()) {
            view.setUint16(index * GlyfReconstructor.WORD_SIZE_BYTES, value);
        }

        return bytes;
    }

    /**
     * The bytes after the flags of a component: the glyph index, argument1 and argument2, then the
     * scale or the matrix its flags name (OpenType 1.9.1, glyf).
     */
    private componentArgumentsSizeBytes(flags: number): number {
        const argumentsSizeBytes =
            (flags & GlyfReconstructor.ARG_1_AND_2_ARE_WORDS) !== 0
                ? GlyfReconstructor.WORD_ARGUMENTS_SIZE_BYTES
                : GlyfReconstructor.BYTE_ARGUMENTS_SIZE_BYTES;
        let transformSizeBytes = 0;

        if ((flags & GlyfReconstructor.WE_HAVE_A_SCALE) !== 0) {
            transformSizeBytes = GlyfReconstructor.SCALE_SIZE_BYTES;
        } else if ((flags & GlyfReconstructor.WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
            transformSizeBytes = GlyfReconstructor.X_AND_Y_SCALE_SIZE_BYTES;
        } else if ((flags & GlyfReconstructor.WE_HAVE_A_TWO_BY_TWO) !== 0) {
            transformSizeBytes = GlyfReconstructor.TWO_BY_TWO_SIZE_BYTES;
        }

        return GlyfReconstructor.GLYPH_INDEX_SIZE_BYTES + argumentsSizeBytes + transformSizeBytes;
    }

    /**
     * The points of a simple glyph: each flag takes 1 to 4 bytes of glyphStream, which give the
     * deltas from the point before it (§5.2).
     */
    private points(flags: Uint8Array): Array<Point> {
        const points: Array<Point> = [];
        let x = 0;
        let y = 0;

        for (const [index, flag] of flags.entries()) {
            const kind = flag & GlyfReconstructor.TRIPLET_KIND_BITS;
            const bytes = this.take(this.glyphStream, this.tripletSizeBytes(kind), `the coordinates of point ${index}`);
            const [dx, dy] = this.deltas(kind, bytes);

            // The decoder keeps coordinates and their differences in C `int`s: a sum past 2³¹ wraps
            // there, and so here, in outline() too.
            x = (x + dx) | 0;
            y = (y + dy) | 0;
            points.push({ x: x, y: y, isOnCurve: (flag & GlyfReconstructor.OFF_CURVE_BIT) === 0 });
        }

        return points;
    }

    private tripletSizeBytes(kind: number): number {
        if (kind < GlyfReconstructor.FIRST_TWO_BYTES_FLAG) {
            return GlyfReconstructor.ONE_BYTE_TRIPLET_SIZE_BYTES;
        }

        if (kind < GlyfReconstructor.FIRST_THREE_BYTES_FLAG) {
            return GlyfReconstructor.TWO_BYTES_TRIPLET_SIZE_BYTES;
        }

        if (kind < GlyfReconstructor.FIRST_FOUR_BYTES_FLAG) {
            return GlyfReconstructor.THREE_BYTES_TRIPLET_SIZE_BYTES;
        }

        return GlyfReconstructor.FOUR_BYTES_TRIPLET_SIZE_BYTES;
    }

    /**
     * The dx and dy of a triplet: the table of §5.2, in the arithmetic of `TripletDecode()` in
     * `woff2_dec.cc` 1.0.2. The kind gives the bits of the magnitudes the bytes do not carry and the
     * signs: bit 0 of the kind is the sign of dx, bit 1 the sign of dy, a set bit positive.
     */
    private deltas(kind: number, bytes: Uint8Array): [number, number] {
        const [byte0 = 0, byte1 = 0, byte2 = 0, byte3 = 0] = bytes;
        const byteBits = GlyfReconstructor.BITS_PER_BYTE;
        const nibbleBits = GlyfReconstructor.BITS_PER_NIBBLE;
        const lowNibble = GlyfReconstructor.LOW_NIBBLE;
        const highByteShift = GlyfReconstructor.HIGH_BYTE_SHIFT;
        const bias = GlyfReconstructor.MAGNITUDE_BIAS;
        const dySignBits = kind >> GlyfReconstructor.DY_SIGN_SHIFT;

        // Flags 0–9 and 10–19: the high byte of the magnitude is bits 1–3 of the flag within its
        // range, 0 to 4, and the bit of the sign is the bit 0 below it.
        if (kind < GlyfReconstructor.FIRST_DX_ONLY_FLAG) {
            return [0, this.withSign(kind, ((kind & GlyfReconstructor.HIGH_BYTE_BITS) << highByteShift) + byte0)];
        }

        if (kind < GlyfReconstructor.FIRST_ONE_BYTE_FLAG) {
            const indexInRange = kind - GlyfReconstructor.FIRST_DX_ONLY_FLAG;

            return [this.withSign(kind, ((indexInRange & GlyfReconstructor.HIGH_BYTE_BITS) << highByteShift) + byte0), 0];
        }

        // Flags 20–83: one byte holds a nibble of each; bits 4–5 and 2–3 of the flag within its
        // range pick 1, 17, 33 or 49 to add to dx and to dy.
        if (kind < GlyfReconstructor.FIRST_TWO_BYTES_FLAG) {
            const indexInRange = kind - GlyfReconstructor.FIRST_ONE_BYTE_FLAG;
            const dxBase = bias + (indexInRange & GlyfReconstructor.ONE_BYTE_DX_BASE_BITS);
            const dyBase =
                bias + (((indexInRange & GlyfReconstructor.ONE_BYTE_DY_BASE_BITS) >> GlyfReconstructor.SIGN_BIT_COUNT) << nibbleBits);

            return [this.withSign(kind, dxBase + (byte0 >> nibbleBits)), this.withSign(dySignBits, dyBase + (byte0 & lowNibble))];
        }

        // Flags 84–119: a byte each; the flag within its range is 12 × the high byte of dx plus
        // 4 × the high byte of dy plus the signs.
        if (kind < GlyfReconstructor.FIRST_THREE_BYTES_FLAG) {
            const indexInRange = kind - GlyfReconstructor.FIRST_TWO_BYTES_FLAG;
            const dxHighByte = Math.floor(indexInRange / GlyfReconstructor.TWO_BYTES_DX_STEP);
            const dyHighByte = indexInRange % GlyfReconstructor.TWO_BYTES_DX_STEP >> GlyfReconstructor.SIGN_BIT_COUNT;

            return [
                this.withSign(kind, bias + (dxHighByte << byteBits) + byte0),
                this.withSign(dySignBits, bias + (dyHighByte << byteBits) + byte1),
            ];
        }

        // Flags 120–123: 12 bits each in three bytes; flags 124–127: 16 bits each in four.
        if (kind < GlyfReconstructor.FIRST_FOUR_BYTES_FLAG) {
            return [
                this.withSign(kind, (byte0 << nibbleBits) + (byte1 >> nibbleBits)),
                this.withSign(dySignBits, ((byte1 & lowNibble) << byteBits) + byte2),
            ];
        }

        return [this.withSign(kind, (byte0 << byteBits) + byte1), this.withSign(dySignBits, (byte2 << byteBits) + byte3)];
    }

    private withSign(signBits: number, magnitude: number): number {
        return (signBits & GlyfReconstructor.POSITIVE_SIGN_BIT) !== 0 ? magnitude : -magnitude;
    }

    /**
     * xMin, yMin, xMax and yMax over every point, on- and off-curve (§5.1); zeros for a glyph whose
     * contours have no points. A coordinate outside Int16 wraps, as in the decoder.
     */
    private boundingBox(points: Array<Point>): Uint8Array {
        const [first] = points;

        if (first === undefined) {
            return new Uint8Array(GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES);
        }

        let xMin = first.x;
        let yMin = first.y;
        let xMax = first.x;
        let yMax = first.y;

        for (const point of points) {
            xMin = Math.min(xMin, point.x);
            yMin = Math.min(yMin, point.y);
            xMax = Math.max(xMax, point.x);
            yMax = Math.max(yMax, point.y);
        }

        return this.words([xMin, yMin, xMax, yMax]);
    }

    /**
     * The flags, the x coordinates and the y coordinates of a simple glyph of glyf, written the way
     * `StorePoints()` writes them (the class comment).
     */
    private outline(points: Array<Point>): Uint8Array {
        const hasOverlap = this.isBitSet(this.overlapSimpleBitmap, this.glyphIndex);
        // A run is a flag and how many times the points after its first repeat it.
        const runs: Array<{ flag: number; repeatCount: number }> = [];
        const xBytes: Array<number> = [];
        const yBytes: Array<number> = [];
        let lastX = 0;
        let lastY = 0;

        for (const [index, point] of points.entries()) {
            let flag = point.isOnCurve ? GlyfReconstructor.ON_CURVE_POINT : 0;

            if (index === 0 && hasOverlap) {
                flag |= GlyfReconstructor.OVERLAP_SIMPLE;
            }

            flag |= this.coordinate(
                (point.x - lastX) | 0,
                xBytes,
                GlyfReconstructor.X_SHORT_VECTOR,
                GlyfReconstructor.X_IS_SAME_OR_POSITIVE,
            );
            flag |= this.coordinate(
                (point.y - lastY) | 0,
                yBytes,
                GlyfReconstructor.Y_SHORT_VECTOR,
                GlyfReconstructor.Y_IS_SAME_OR_POSITIVE,
            );
            lastX = point.x;
            lastY = point.y;

            const lastRun = runs.at(-1);

            if (lastRun?.flag === flag && lastRun.repeatCount < GlyfReconstructor.MAX_REPEAT_COUNT) {
                lastRun.repeatCount++;
            } else {
                runs.push({ flag: flag, repeatCount: 0 });
            }
        }

        const flagBytes: Array<number> = [];

        for (const { flag, repeatCount } of runs) {
            if (repeatCount === 0) {
                flagBytes.push(flag);
            } else {
                flagBytes.push(flag | GlyfReconstructor.REPEAT_FLAG, repeatCount);
            }
        }

        return Uint8Array.from([...flagBytes, ...xBytes, ...yBytes]);
    }

    /**
     * Appends the bytes of one delta to `bytes` and returns the bits of the flag it sets.
     */
    private coordinate(delta: number, bytes: Array<number>, shortVectorBit: number, sameOrPositiveBit: number): number {
        if (delta === 0) {
            return sameOrPositiveBit;
        }

        if (Math.abs(delta) <= GlyfReconstructor.MAX_SHORT_DELTA) {
            bytes.push(Math.abs(delta));

            return delta > 0 ? shortVectorBit | sameOrPositiveBit : shortVectorBit;
        }

        // A word of the delta in two's complement: a delta outside Int16 wraps, as in the decoder.
        bytes.push((delta >> GlyfReconstructor.BITS_PER_BYTE) & GlyfReconstructor.BYTE_MASK, delta & GlyfReconstructor.BYTE_MASK);

        return 0;
    }

    private xMin(record: Uint8Array): number {
        if (record.length === 0) {
            return 0;
        }

        return new DataView(record.buffer, record.byteOffset, record.byteLength).getInt16(GlyfReconstructor.X_MIN_OFFSET_BYTES);
    }

    /**
     * The decoder cuts a short offset, the offset halved, to 16 bits, so that the offsets of a glyf
     * over 128 KiB wrap and point at the wrong glyph records. §5.3 has nothing for an offset that
     * does not fit, and the sfnt it writes is broken: we reject it.
     */
    private checkGlyfFitsLoca(glyfSizeBytes: number): void {
        if (this.locaOffsetSizeBytes !== GlyfReconstructor.SHORT_LOCA_OFFSET_SIZE_BYTES) {
            return;
        }

        if (glyfSizeBytes > GlyfReconstructor.MAX_SHORT_LOCA_OFFSET_BYTES) {
            throw this.brokenTable(Woff2Rule.ShortLocaGlyfSize, {
                field: "rebuilt length",
                value: glyfSizeBytes,
                expected: `at most ${GlyfReconstructor.MAX_SHORT_LOCA_OFFSET_BYTES}, as indexFormat is ${this.indexFormat}`,
            });
        }
    }

    /**
     * loca in the format indexFormat names (§5.3): a short offset is the offset halved.
     */
    private loca(offsets: Array<number>): Uint8Array {
        const offsetSizeBytes = this.locaOffsetSizeBytes;
        const isShort = offsetSizeBytes === GlyfReconstructor.SHORT_LOCA_OFFSET_SIZE_BYTES;
        const loca = new Uint8Array(offsets.length * offsetSizeBytes);
        const view = new DataView(loca.buffer);

        for (const [index, offset] of offsets.entries()) {
            if (isShort) {
                view.setUint16(index * offsetSizeBytes, offset / GlyfReconstructor.SHORT_LOCA_DIVISOR);
            } else {
                view.setUint32(index * offsetSizeBytes, offset);
            }
        }

        return loca;
    }

    /**
     * The transformed hmtx with what its rebuilding needs, once rule `Woff2Rule.TransformedHmtx` holds: hhea
     * holds numberOfHMetrics, which is 1 to numGlyphs, and the table holds the arrays its flags keep
     * (§5.4). Its flags byte is checked by `Woff2FontValidator` before, by rule `HmtxTransform`.
     */
    private rebuildableHmtx({ bytes, hhea }: TransformedHmtxWithHhea): RebuildableHmtx {
        if (hhea === undefined) {
            throw this.brokenHmtx({
                at: "the table directory",
                field: BrokenWoff2.tableName(TableTag.Hhea),
                value: "absent",
                expected: `present, as ${BrokenWoff2.tableName(TableTag.Hmtx)} is transformed`,
            });
        }

        if (hhea.length < GlyfReconstructor.HHEA_MIN_SIZE_BYTES) {
            throw this.brokenHmtx({
                at: BrokenWoff2.tableName(TableTag.Hhea),
                field: "origLength",
                value: hhea.length,
                expected: `at least ${GlyfReconstructor.HHEA_MIN_SIZE_BYTES}, to hold numberOfHMetrics`,
            });
        }

        const numberOfHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(
            GlyfReconstructor.NUMBER_OF_H_METRICS_OFFSET_BYTES,
        );

        if (numberOfHMetrics < GlyfReconstructor.MIN_NUMBER_OF_H_METRICS || numberOfHMetrics > this.numGlyphs) {
            throw this.brokenHmtx({
                at: BrokenWoff2.tableName(TableTag.Hhea),
                field: "numberOfHMetrics",
                value: numberOfHMetrics,
                expected: `${GlyfReconstructor.MIN_NUMBER_OF_H_METRICS} to ${this.numGlyphs}, numGlyphs of the transformed glyf`,
            });
        }

        const flags = bytes[0] ?? 0;
        const hasLsb = (flags & GlyfReconstructor.NO_LSB_FLAG) === 0;
        const hasLeftSideBearing = (flags & GlyfReconstructor.NO_LEFT_SIDE_BEARING_FLAG) === 0;
        let wordCount = numberOfHMetrics;

        if (hasLsb) {
            wordCount += numberOfHMetrics;
        }

        if (hasLeftSideBearing) {
            wordCount += this.numGlyphs - numberOfHMetrics;
        }

        const sizeBytes = GlyfReconstructor.HMTX_FLAGS_SIZE_BYTES + wordCount * GlyfReconstructor.WORD_SIZE_BYTES;

        if (bytes.length < sizeBytes) {
            throw this.brokenHmtx({
                at: BrokenWoff2.tableName(TableTag.Hmtx),
                field: "transformLength",
                value: bytes.length,
                expected: `at least ${sizeBytes}, for flags ${flags} and numberOfHMetrics ${numberOfHMetrics}`,
            });
        }

        return { bytes: bytes, numberOfHMetrics: numberOfHMetrics, hasLsb: hasLsb, hasLeftSideBearing: hasLeftSideBearing };
    }

    /**
     * hmtx from the transformed one (§5.4): the advance widths as they are, and the left side
     * bearings of each array the flags drop taken from the xMin of the glyphs.
     */
    private hmtx({ bytes, numberOfHMetrics, hasLsb, hasLeftSideBearing }: RebuildableHmtx, xMins: Array<number>): Uint8Array {
        // The values follow the flags byte in the order of the glyphs: advanceWidth[], then lsb[] of
        // the proportional glyphs, then leftSideBearing[] of the monospaced ones.
        const values: Substream = { name: "the transformed hmtx", bytes: bytes, offsetBytes: GlyfReconstructor.HMTX_FLAGS_SIZE_BYTES };
        const nextWord = (): number => this.readUint16(values, "a value of the transformed hmtx");
        const advanceWidths: Array<number> = [];
        const metrics: Array<number> = [];

        for (let glyphIndex = 0; glyphIndex < numberOfHMetrics; glyphIndex++) {
            advanceWidths.push(nextWord());
        }

        for (let glyphIndex = 0; glyphIndex < this.numGlyphs; glyphIndex++) {
            const isProportional = glyphIndex < numberOfHMetrics;
            const isStored = isProportional ? hasLsb : hasLeftSideBearing;
            const leftSideBearing = isStored ? nextWord() : xMins[glyphIndex] ?? 0;
            const advanceWidth = advanceWidths[glyphIndex];

            if (advanceWidth !== undefined) {
                metrics.push(advanceWidth);
            }

            metrics.push(leftSideBearing);
        }

        return this.words(metrics);
    }

    private bboxBitmapSizeBytes(): number {
        const wordCount = Math.floor(
            (this.numGlyphs + GlyfReconstructor.BITMAP_WORD_SIZE_BITS - 1) / GlyfReconstructor.BITMAP_WORD_SIZE_BITS,
        );

        return wordCount * GlyfReconstructor.BITMAP_WORD_SIZE_BYTES;
    }

    /**
     * Whether bboxBitmap gives the glyph being read an explicit bounding box.
     */
    private hasBoundingBox(): boolean {
        return this.isBitSet(this.bboxBitmap, this.glyphIndex);
    }

    private isBitSet(bitmap: Uint8Array | undefined, glyphIndex: number): boolean {
        const byte = bitmap?.[Math.floor(glyphIndex / GlyfReconstructor.BITS_PER_BYTE)] ?? 0;

        return (byte & (GlyfReconstructor.FIRST_GLYPH_BIT >> glyphIndex % GlyfReconstructor.BITS_PER_BYTE)) !== 0;
    }

    /**
     * The next `lengthBytes` of the substream; the substream running out breaks a rule. `purpose`
     * says in the answer what the glyph record takes the bytes for.
     */
    private take(stream: Substream, lengthBytes: number, purpose: string): Uint8Array {
        const bytesLeft = stream.bytes.length - stream.offsetBytes;

        if (bytesLeft < lengthBytes) {
            throw this.brokenGlyph(Woff2Rule.GlyphStreams, {
                field: `bytes left in ${stream.name}`,
                value: bytesLeft,
                expected: `at least ${lengthBytes}, for ${purpose}`,
            });
        }

        const bytes = stream.bytes.subarray(stream.offsetBytes, stream.offsetBytes + lengthBytes);

        stream.offsetBytes += lengthBytes;

        return bytes;
    }

    private readUint16(stream: Substream, purpose: string): number {
        const bytes = this.take(stream, GlyfReconstructor.WORD_SIZE_BYTES, purpose);

        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
    }

    private readInt16(stream: Substream, purpose: string): number {
        const bytes = this.take(stream, GlyfReconstructor.WORD_SIZE_BYTES, purpose);

        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(0);
    }

    private read255UInt16(stream: Substream, purpose: string): number {
        const [code = 0] = this.take(stream, GlyfReconstructor.CODE_SIZE_BYTES, purpose);

        if (code === GlyfReconstructor.WORD_CODE) {
            return this.readUint16(stream, purpose);
        }

        if (code === GlyfReconstructor.ONE_MORE_BYTE_CODE_1) {
            const [byte = 0] = this.take(stream, GlyfReconstructor.CODE_SIZE_BYTES, purpose);

            return byte + GlyfReconstructor.ONE_MORE_BYTE_CODE_1_BASE;
        }

        if (code === GlyfReconstructor.ONE_MORE_BYTE_CODE_2) {
            const [byte = 0] = this.take(stream, GlyfReconstructor.CODE_SIZE_BYTES, purpose);

            return byte + GlyfReconstructor.ONE_MORE_BYTE_CODE_2_BASE;
        }

        return code;
    }

    private brokenHmtx(violation: Omit<Violation, "rule">): BrokenWoff2 {
        return BrokenWoff2.byRule(this.fontPath, { ...violation, rule: Woff2Rule.TransformedHmtx });
    }

    private brokenTable(rule: Woff2Rule, violation: Omit<Violation, "rule" | "at">): BrokenWoff2 {
        return BrokenWoff2.byRule(this.fontPath, { ...violation, rule: rule, at: BrokenWoff2.tableName(TableTag.Glyf) });
    }

    private brokenGlyph(rule: Woff2Rule, violation: Omit<Violation, "rule" | "at">): BrokenWoff2 {
        return BrokenWoff2.byRule(this.fontPath, {
            ...violation,
            rule: rule,
            at: `glyph ${this.glyphIndex} of ${BrokenWoff2.tableName(TableTag.Glyf)}`,
        });
    }
}
