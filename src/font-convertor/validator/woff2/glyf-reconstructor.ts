import { BrokenWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import type {
    Point,
    ReconstructedTables,
    Substream,
    TransformedHmtx,
    Violation,
} from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import { Woff2Rule } from "app/font-convertor/validator/woff2/woff2-font-validator.types";

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
 *   component flags has WE_HAVE_INSTRUCTIONS.
 *
 * The OVERLAP_SIMPLE bit the overlapSimpleBitmap gives a simple glyph goes on its first flag, as
 * §5.1 says, before the flag is compared with the next one for "repeat". Decoder 1.0.2 knows
 * nothing of the bitmap, so no output of a decoder was compared with this.
 */
export class GlyfReconstructor {
    // The header of a transformed glyf (§5.1): reserved, optionFlags, numGlyphs, indexFormat, then
    // the sizes of the seven substreams that follow it, one UInt32 each.
    private static readonly HEADER_SIZE_BYTES = 36;
    private static readonly FIELD_OFFSETS = { optionFlags: 2, numGlyphs: 4, indexFormat: 6, substreamSizes: 8 };
    private static readonly SUBSTREAM_SIZE_FIELD_BYTES = 4;
    private static readonly OVERLAP_SIMPLE_BITMAP_FLAG = 0x0001;
    // bboxBitmap and overlapSimpleBitmap hold a bit per glyph, padded to whole 32-bit words:
    // 4 × ⌊(numGlyphs + 31) / 32⌋ bytes. Glyph 0 is the most significant bit of the first byte.
    private static readonly BITMAP_WORD_SIZE_BITS = 32;
    private static readonly BITMAP_WORD_SIZE_BYTES = 4;
    private static readonly BITS_PER_BYTE = 8;
    private static readonly FIRST_GLYPH_BIT = 0x80;
    private static readonly COMPOSITE_CONTOURS = -1;
    private static readonly EMPTY_CONTOURS = 0;
    // 255UInt16 (§3.1): a byte below 253 is the value; 253 says a UInt16 follows, 255 and 254 say a
    // byte follows that adds 253 or 2 × 253.
    private static readonly WORD_CODE = 253;
    private static readonly ONE_MORE_BYTE_CODE_2 = 254;
    private static readonly ONE_MORE_BYTE_CODE_1 = 255;
    private static readonly LOWEST_U_CODE = 253;
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
    // A glyph record of glyf: numberOfContours and the bounding box, xMin first, take 10 bytes.
    private static readonly GLYPH_HEADER_SIZE_BYTES = 10;
    private static readonly X_MIN_OFFSET = 2;
    private static readonly BOUNDING_BOX_SIZE_BYTES = 8;
    private static readonly MAX_END_POINT = 0xffff;
    private static readonly GLYPH_ALIGNMENT_BYTES = 4;
    // glyf and hmtx hold 16-bit words: endPtsOfContours, instructionLength, the metrics.
    private static readonly WORD_SIZE_BYTES = 2;
    // An offset of loca takes 2 bytes, the offset halved, when indexFormat is 0, and 4 otherwise (§5.3).
    private static readonly SHORT_LOCA_FORMAT = 0;
    private static readonly SHORT_LOCA_OFFSET_SIZE_BYTES = 2;
    private static readonly LONG_LOCA_OFFSET_SIZE_BYTES = 4;
    private static readonly SHORT_LOCA_DIVISOR = 2;
    // The transformed hmtx (§5.4): a flags byte, then UInt16 and Int16 values.
    private static readonly HMTX_FLAGS_SIZE_BYTES = 1;
    private static readonly NO_LSB_FLAG = 0x01;
    private static readonly NO_LEFT_SIDE_BEARING_FLAG = 0x02;

    public readonly numGlyphs: number;
    public readonly indexFormat: number;
    private readonly nContourStream: Substream;
    private readonly nPointsStream: Substream;
    private readonly flagStream: Substream;
    private readonly glyphStream: Substream;
    private readonly compositeStream: Substream;
    private readonly bboxStream: Substream;
    private readonly instructionStream: Substream;
    private readonly overlapSimpleBitmap: Uint8Array | undefined;
    // The glyph being read: every answer about a glyph record names it.
    private glyphIndex = 0;

    /**
     * Reads the header and cuts the substreams. Throws `BrokenWoff2` when the table is shorter than
     * its header, the substreams run past it, or the overlapSimpleBitmap bit 0 of optionFlags calls
     * for is not there.
     */
    public constructor(private readonly fontPath: string, transformedGlyf: Uint8Array) {
        const headerSizeBytes = GlyfReconstructor.HEADER_SIZE_BYTES;

        if (transformedGlyf.length < headerSizeBytes) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "transformLength",
                value: transformedGlyf.length,
                expected: `at least ${headerSizeBytes}, the size of the header`,
            });
        }

        const view = new DataView(transformedGlyf.buffer, transformedGlyf.byteOffset, transformedGlyf.byteLength);
        const fields = GlyfReconstructor.FIELD_OFFSETS;
        let substreamsEnd = headerSizeBytes;

        // The substreams lie one after another in the order of their sizes in the header.
        const cut = (index: number, name: string): Substream => {
            const sizeBytes = view.getUint32(fields.substreamSizes + index * GlyfReconstructor.SUBSTREAM_SIZE_FIELD_BYTES);
            const substream = { name: name, bytes: transformedGlyf.subarray(substreamsEnd, substreamsEnd + sizeBytes), offset: 0 };

            substreamsEnd += sizeBytes;

            return substream;
        };

        this.numGlyphs = view.getUint16(fields.numGlyphs);
        this.indexFormat = view.getUint16(fields.indexFormat);
        this.nContourStream = cut(0, "nContourStream");
        this.nPointsStream = cut(1, "nPointsStream");
        this.flagStream = cut(2, "flagStream");
        this.glyphStream = cut(3, "glyphStream");
        this.compositeStream = cut(4, "compositeStream");
        this.bboxStream = cut(5, "bboxStream");
        this.instructionStream = cut(6, "instructionStream");

        if (substreamsEnd > transformedGlyf.length) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "end of the substreams",
                value: substreamsEnd,
                expected: `at most ${transformedGlyf.length}, the transformLength`,
            });
        }

        if ((view.getUint16(fields.optionFlags) & GlyfReconstructor.OVERLAP_SIMPLE_BITMAP_FLAG) === 0) {
            return;
        }

        const bitmapEnd = substreamsEnd + this.bitmapSizeBytes();

        if (bitmapEnd > transformedGlyf.length) {
            throw this.brokenTable(Woff2Rule.TransformedGlyf, {
                field: "end of overlapSimpleBitmap",
                value: bitmapEnd,
                expected: `at most ${transformedGlyf.length}, the transformLength, as bit 0 of optionFlags is set`,
            });
        }

        this.overlapSimpleBitmap = transformedGlyf.subarray(substreamsEnd, bitmapEnd);
    }

    /**
     * Reads the glyph records one by one, each taking what it needs from the substreams, and lays
     * them out into glyf with their offsets in loca; then rebuilds `transformedHmtx`, if given, from
     * the xMin of the glyphs. Throws `BrokenWoff2` on the first glyph record that cannot be decoded,
     * or a transformed hmtx that does not hold what its flags and numberOfHMetrics call for.
     */
    public reconstruct(transformedHmtx: TransformedHmtx | undefined): ReconstructedTables {
        const bboxBitmap = this.take(this.bboxStream, this.bitmapSizeBytes(), "bboxBitmap");
        const records: Array<Uint8Array> = [];
        const offsets: Array<number> = [];
        const xMins: Array<number> = [];
        let glyfSizeBytes = 0;

        for (this.glyphIndex = 0; this.glyphIndex < this.numGlyphs; this.glyphIndex++) {
            const record = this.glyphRecord(this.isBitSet(bboxBitmap, this.glyphIndex));
            const paddedRecord = new Uint8Array(this.padded(record.length));

            paddedRecord.set(record);
            records.push(paddedRecord);
            offsets.push(glyfSizeBytes);
            xMins.push(this.xMin(record));
            glyfSizeBytes += paddedRecord.length;
        }

        offsets.push(glyfSizeBytes);

        return {
            glyf: Buffer.concat(records),
            loca: this.loca(offsets),
            hmtx: transformedHmtx === undefined ? undefined : this.hmtx(transformedHmtx, xMins),
        };
    }

    private glyphRecord(hasBoundingBox: boolean): Uint8Array {
        const nContour = this.readInt16(this.nContourStream, "nContour");

        if (nContour === GlyfReconstructor.COMPOSITE_CONTOURS) {
            return this.compositeGlyph(hasBoundingBox);
        }

        if (nContour === GlyfReconstructor.EMPTY_CONTOURS) {
            return this.emptyGlyph(hasBoundingBox);
        }

        if (nContour > 0) {
            return this.simpleGlyph(nContour, hasBoundingBox);
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
    private emptyGlyph(hasBoundingBox: boolean): Uint8Array {
        if (hasBoundingBox) {
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
    private simpleGlyph(nContour: number, hasBoundingBox: boolean): Uint8Array {
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
        const boundingBox = hasBoundingBox
            ? this.take(this.bboxStream, GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES, "the bounding box")
            : this.boundingBox(points);
        const outline = this.outline(points, this.isBitSet(this.overlapSimpleBitmap, this.glyphIndex));

        return Buffer.concat([
            this.glyphHeader(nContour, boundingBox),
            this.uint16s([...endPoints, instructionLength]),
            instructions,
            outline,
        ]);
    }

    /**
     * The steps of §5.1 for a composite glyph: the components from compositeStream as they are, the
     * bounding box from bboxStream, and the instructions when a component flag calls for them.
     */
    private compositeGlyph(hasBoundingBox: boolean): Uint8Array {
        if (!hasBoundingBox) {
            throw this.brokenGlyph(Woff2Rule.CompositeBoundingBox, {
                field: "bit in bboxBitmap",
                value: 0,
                expected: "1, as nContour is -1",
            });
        }

        const componentsStart = this.compositeStream.offset;
        let hasInstructions = false;
        let component = 0;
        let flags: number;

        do {
            component++;
            flags = this.readUint16(this.compositeStream, `the flags of component ${component}`);
            hasInstructions ||= (flags & GlyfReconstructor.WE_HAVE_INSTRUCTIONS) !== 0;
            this.take(this.compositeStream, this.componentArgumentsSizeBytes(flags), `the arguments of component ${component}`);
        } while ((flags & GlyfReconstructor.MORE_COMPONENTS) !== 0);

        const components = this.compositeStream.bytes.subarray(componentsStart, this.compositeStream.offset);
        const boundingBox = this.take(this.bboxStream, GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES, "the bounding box");
        const header = this.glyphHeader(GlyfReconstructor.COMPOSITE_CONTOURS, boundingBox);

        if (!hasInstructions) {
            return Buffer.concat([header, components]);
        }

        const instructionLength = this.read255UInt16(this.glyphStream, "instructionLength");
        const instructions = this.take(this.instructionStream, instructionLength, "the instructions");

        return Buffer.concat([header, components, this.uint16s([instructionLength]), instructions]);
    }

    /**
     * numberOfContours and the bounding box: the first 10 bytes of a glyph record of glyf.
     */
    private glyphHeader(nContour: number, boundingBox: Uint8Array): Uint8Array {
        const header = new Uint8Array(GlyfReconstructor.GLYPH_HEADER_SIZE_BYTES);

        new DataView(header.buffer).setInt16(0, nContour);
        header.set(boundingBox, GlyfReconstructor.X_MIN_OFFSET);

        return header;
    }

    /**
     * The values as big-endian 16-bit words, as glyf and hmtx hold them. A negative value is written
     * in two's complement.
     */
    private uint16s(values: Array<number>): Uint8Array {
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
        const glyphIndexSizeBytes = 2;
        const argumentsSizeBytes = (flags & GlyfReconstructor.ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2;
        let transformSizeBytes = 0;

        if ((flags & GlyfReconstructor.WE_HAVE_A_SCALE) !== 0) {
            transformSizeBytes = 2;
        } else if ((flags & GlyfReconstructor.WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
            transformSizeBytes = 4;
        } else if ((flags & GlyfReconstructor.WE_HAVE_A_TWO_BY_TWO) !== 0) {
            transformSizeBytes = 8;
        }

        return glyphIndexSizeBytes + argumentsSizeBytes + transformSizeBytes;
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

            x += dx;
            y += dy;
            points.push({ x: x, y: y, isOnCurve: (flag & GlyfReconstructor.OFF_CURVE_BIT) === 0 });
        }

        return points;
    }

    private tripletSizeBytes(kind: number): number {
        if (kind < GlyfReconstructor.FIRST_TWO_BYTES_FLAG) {
            return 1;
        }

        if (kind < GlyfReconstructor.FIRST_THREE_BYTES_FLAG) {
            return 2;
        }

        if (kind < GlyfReconstructor.FIRST_FOUR_BYTES_FLAG) {
            return 3;
        }

        return 4;
    }

    /**
     * The dx and dy of a triplet: the table of §5.2, in the arithmetic of `TripletDecode()` in
     * `woff2_dec.cc` 1.0.2. The kind gives the bits of the magnitudes the bytes do not carry and the
     * signs: bit 0 of the kind is the sign of dx, bit 1 the sign of dy, a set bit positive.
     */
    private deltas(kind: number, bytes: Uint8Array): [number, number] {
        const [byte0 = 0, byte1 = 0, byte2 = 0, byte3 = 0] = bytes;

        if (kind < GlyfReconstructor.FIRST_DX_ONLY_FLAG) {
            return [0, this.withSign(kind, ((kind & 14) << 7) + byte0)];
        }

        if (kind < GlyfReconstructor.FIRST_ONE_BYTE_FLAG) {
            return [this.withSign(kind, (((kind - GlyfReconstructor.FIRST_DX_ONLY_FLAG) & 14) << 7) + byte0), 0];
        }

        if (kind < GlyfReconstructor.FIRST_TWO_BYTES_FLAG) {
            const high = kind - GlyfReconstructor.FIRST_ONE_BYTE_FLAG;

            return [
                this.withSign(kind, 1 + (high & 0x30) + (byte0 >> 4)),
                this.withSign(kind >> 1, 1 + ((high & 0x0c) << 2) + (byte0 & 0x0f)),
            ];
        }

        if (kind < GlyfReconstructor.FIRST_THREE_BYTES_FLAG) {
            const high = kind - GlyfReconstructor.FIRST_TWO_BYTES_FLAG;

            return [
                this.withSign(kind, 1 + (Math.floor(high / 12) << 8) + byte0),
                this.withSign(kind >> 1, 1 + ((high % 12 >> 2) << 8) + byte1),
            ];
        }

        if (kind < GlyfReconstructor.FIRST_FOUR_BYTES_FLAG) {
            return [this.withSign(kind, (byte0 << 4) + (byte1 >> 4)), this.withSign(kind >> 1, ((byte1 & 0x0f) << 8) + byte2)];
        }

        return [this.withSign(kind, (byte0 << 8) + byte1), this.withSign(kind >> 1, (byte2 << 8) + byte3)];
    }

    private withSign(signBits: number, magnitude: number): number {
        return (signBits & 1) !== 0 ? magnitude : -magnitude;
    }

    /**
     * xMin, yMin, xMax and yMax over every point, on- and off-curve (§5.1); zeros for a glyph whose
     * contours have no points. A coordinate outside Int16 wraps, as in the decoder.
     */
    private boundingBox(points: Array<Point>): Uint8Array {
        const box = new Uint8Array(GlyfReconstructor.BOUNDING_BOX_SIZE_BYTES);
        const view = new DataView(box.buffer);
        const [first] = points;

        if (first === undefined) {
            return box;
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

        view.setInt16(0, xMin);
        view.setInt16(2, yMin);
        view.setInt16(4, xMax);
        view.setInt16(6, yMax);

        return box;
    }

    /**
     * The flags, the x coordinates and the y coordinates of a simple glyph of glyf, written the way
     * `StorePoints()` writes them (the class comment).
     */
    private outline(points: Array<Point>, hasOverlap: boolean): Uint8Array {
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

            flag |= this.coordinate(point.x - lastX, xBytes, GlyfReconstructor.X_SHORT_VECTOR, GlyfReconstructor.X_IS_SAME_OR_POSITIVE);
            flag |= this.coordinate(point.y - lastY, yBytes, GlyfReconstructor.Y_SHORT_VECTOR, GlyfReconstructor.Y_IS_SAME_OR_POSITIVE);
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
    private coordinate(delta: number, bytes: Array<number>, shortVector: number, isSameOrPositive: number): number {
        if (delta === 0) {
            return isSameOrPositive;
        }

        if (Math.abs(delta) <= GlyfReconstructor.MAX_SHORT_DELTA) {
            bytes.push(Math.abs(delta));

            return delta > 0 ? shortVector | isSameOrPositive : shortVector;
        }

        // A word of the delta in two's complement: a delta outside Int16 wraps, as in the decoder.
        bytes.push((delta >> 8) & 0xff, delta & 0xff);

        return 0;
    }

    private xMin(record: Uint8Array): number {
        if (record.length === 0) {
            return 0;
        }

        return new DataView(record.buffer, record.byteOffset, record.byteLength).getInt16(GlyfReconstructor.X_MIN_OFFSET);
    }

    /**
     * loca in the format indexFormat names (§5.3). A short offset is the offset halved, cut to 16
     * bits as in the decoder: glyf over 128 KiB does not fit the short format.
     */
    private loca(offsets: Array<number>): Uint8Array {
        const isShort = this.indexFormat === GlyfReconstructor.SHORT_LOCA_FORMAT;
        const offsetSizeBytes = isShort ? GlyfReconstructor.SHORT_LOCA_OFFSET_SIZE_BYTES : GlyfReconstructor.LONG_LOCA_OFFSET_SIZE_BYTES;
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
     * hmtx from the transformed one (§5.4): the advance widths as they are, and the left side
     * bearings each array of which the flags drop taken from the xMin of the glyphs. The flags were
     * checked with the table directory.
     */
    private hmtx({ bytes, numberOfHMetrics }: TransformedHmtx, xMins: Array<number>): Uint8Array {
        if (numberOfHMetrics < 1 || numberOfHMetrics > this.numGlyphs) {
            throw BrokenWoff2.byRule(this.fontPath, {
                rule: Woff2Rule.TransformedHmtx,
                at: 'table "hhea"',
                field: "numberOfHMetrics",
                value: numberOfHMetrics,
                expected: `1 to ${this.numGlyphs}, numGlyphs of the transformed glyf`,
            });
        }

        const flags = bytes[0] ?? 0;
        const hasLsb = (flags & GlyfReconstructor.NO_LSB_FLAG) === 0;
        const hasLeftSideBearing = (flags & GlyfReconstructor.NO_LEFT_SIDE_BEARING_FLAG) === 0;
        const monospacedCount = this.numGlyphs - numberOfHMetrics;
        let valueCount = numberOfHMetrics;

        if (hasLsb) {
            valueCount += numberOfHMetrics;
        }

        if (hasLeftSideBearing) {
            valueCount += monospacedCount;
        }

        const sizeBytes = GlyfReconstructor.HMTX_FLAGS_SIZE_BYTES + valueCount * GlyfReconstructor.WORD_SIZE_BYTES;

        if (bytes.length < sizeBytes) {
            throw BrokenWoff2.byRule(this.fontPath, {
                rule: Woff2Rule.TransformedHmtx,
                at: 'table "hmtx"',
                field: "transformLength",
                value: bytes.length,
                expected: `at least ${sizeBytes}, for flags ${flags} and numberOfHMetrics ${numberOfHMetrics}`,
            });
        }

        // The values follow the flags byte in the order of the glyphs: advanceWidth[], then lsb[] of
        // the proportional glyphs, then leftSideBearing[] of the monospaced ones.
        const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let inputOffset = GlyfReconstructor.HMTX_FLAGS_SIZE_BYTES;
        const nextWord = (): number => {
            const value = input.getUint16(inputOffset);

            inputOffset += GlyfReconstructor.WORD_SIZE_BYTES;

            return value;
        };
        const advanceWidths: Array<number> = [];
        const metrics: Array<number> = [];

        for (let glyph = 0; glyph < numberOfHMetrics; glyph++) {
            advanceWidths.push(nextWord());
        }

        for (let glyph = 0; glyph < this.numGlyphs; glyph++) {
            const isProportional = glyph < numberOfHMetrics;
            const isStored = isProportional ? hasLsb : hasLeftSideBearing;
            const leftSideBearing = isStored ? nextWord() : xMins[glyph] ?? 0;
            const advanceWidth = advanceWidths[glyph];

            if (advanceWidth !== undefined) {
                metrics.push(advanceWidth);
            }

            metrics.push(leftSideBearing);
        }

        return this.uint16s(metrics);
    }

    private bitmapSizeBytes(): number {
        const wordCount = Math.floor(
            (this.numGlyphs + GlyfReconstructor.BITMAP_WORD_SIZE_BITS - 1) / GlyfReconstructor.BITMAP_WORD_SIZE_BITS,
        );

        return wordCount * GlyfReconstructor.BITMAP_WORD_SIZE_BYTES;
    }

    private isBitSet(bitmap: Uint8Array | undefined, glyph: number): boolean {
        const byte = bitmap?.[Math.floor(glyph / GlyfReconstructor.BITS_PER_BYTE)] ?? 0;

        return (byte & (GlyfReconstructor.FIRST_GLYPH_BIT >> glyph % GlyfReconstructor.BITS_PER_BYTE)) !== 0;
    }

    private padded(lengthBytes: number): number {
        return Math.ceil(lengthBytes / GlyfReconstructor.GLYPH_ALIGNMENT_BYTES) * GlyfReconstructor.GLYPH_ALIGNMENT_BYTES;
    }

    /**
     * The next `lengthBytes` of the substream; the substream running out breaks a rule. `purpose`
     * says in the answer what the glyph record takes the bytes for.
     */
    private take(stream: Substream, lengthBytes: number, purpose: string): Uint8Array {
        const bytesLeft = stream.bytes.length - stream.offset;

        if (bytesLeft < lengthBytes) {
            throw this.brokenGlyph(Woff2Rule.GlyphStreams, {
                field: `bytes left in ${stream.name}`,
                value: bytesLeft,
                expected: `at least ${lengthBytes}, for ${purpose}`,
            });
        }

        const bytes = stream.bytes.subarray(stream.offset, stream.offset + lengthBytes);

        stream.offset += lengthBytes;

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
        const [code = 0] = this.take(stream, 1, purpose);

        if (code === GlyfReconstructor.WORD_CODE) {
            return this.readUint16(stream, purpose);
        }

        if (code === GlyfReconstructor.ONE_MORE_BYTE_CODE_1) {
            const [byte = 0] = this.take(stream, 1, purpose);

            return byte + GlyfReconstructor.LOWEST_U_CODE;
        }

        if (code === GlyfReconstructor.ONE_MORE_BYTE_CODE_2) {
            const [byte = 0] = this.take(stream, 1, purpose);

            return byte + 2 * GlyfReconstructor.LOWEST_U_CODE;
        }

        return code;
    }

    private brokenTable(rule: Woff2Rule, violation: Omit<Violation, "rule" | "at">): BrokenWoff2 {
        return BrokenWoff2.byRule(this.fontPath, { ...violation, rule: rule, at: 'table "glyf"' });
    }

    private brokenGlyph(rule: Woff2Rule, violation: Omit<Violation, "rule" | "at">): BrokenWoff2 {
        return BrokenWoff2.byRule(this.fontPath, { ...violation, rule: rule, at: `glyph ${this.glyphIndex} of table "glyf"` });
    }
}
