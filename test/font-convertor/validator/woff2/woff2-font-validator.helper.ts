import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { Extension } from "app/font-convertor/font-convertor.types";

// The substreams of a transformed glyf, in the order of their sizes in its header (§5.1).
const GLYF_STREAMS = ["nContour", "nPoints", "flag", "glyph", "composite", "bbox", "instruction"] as const;

function readUint8(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(offset);
}

export const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

export const HEADER_SIZE_BYTES = 48;

// The header fields by their offset (WOFF 2.0, §3.2).
export const FLAVOR = 4;
export const LENGTH = 8;
export const NUM_TABLES = 12;
export const RESERVED = 14;
export const TOTAL_SFNT_SIZE = 16;
export const TOTAL_COMPRESSED_SIZE = 20;
export const META_OFFSET = 28;
export const META_LENGTH = 32;
export const META_ORIG_LENGTH = 36;
export const PRIV_OFFSET = 40;
export const PRIV_LENGTH = 44;
// The fields of a transformed glyf by their offset in it (§5.1).
export const GLYF_OPTION_FLAGS = 2;
export const GLYF_NUM_GLYPHS = 4;
export const GLYF_INDEX_FORMAT = 6;
export const GLYF_N_CONTOUR_STREAM_SIZE = 8;
export const GLYF_HEADER_SIZE_BYTES = 36;
// numberOfHMetrics by its offset in hhea (OpenType 1.9.1, hhea).
export const HHEA_NUMBER_OF_H_METRICS = 34;

// The "Known Table Tags" of §4.1, by their index in the flags byte.
export const KNOWN_TAGS = [
    ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT"],
    ["EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH"],
    ["CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar"],
    ["gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"],
].flat();
export const ARBITRARY_TAG_INDEX = 63;

export type GlyfStream = (typeof GLYF_STREAMS)[number];

/**
 * A table directory entry (§4.1) with the bytes the table puts into the decompressed stream.
 */
export type Entry = {
    tag: string;
    transformVersion: number;
    /** The tag is written after flag 63 rather than as its index among the known tags. */
    isTagExplicit: boolean;
    origLength: number;
    /** Written after origLength when set. */
    transformLength: number | undefined;
    /** Written in place of the UIntBase128 of origLength. */
    origLengthBytes?: Uint8Array;
    /** Written in place of the UIntBase128 of transformLength. */
    transformLengthBytes?: Uint8Array;
    /** The table in the stream: transformLength bytes of it when transformed, origLength otherwise. */
    data: Uint8Array;
};

/**
 * What `build()` of the validator spec lays out into a WOFF2.
 */
export type Layout = {
    flavor: number;
    reserved: number;
    totalSfntSize: number;
    /** In directory order, which is the order of the stream (§4.1). */
    entries: Array<Entry>;
    /** Written in place of the data of the entries compressed as the fixture is. */
    compressed?: Uint8Array;
    metadata?: { stored: Uint8Array; origLength: number };
    privateData?: Uint8Array | undefined;
};

/**
 * A transformed glyf cut into its parts: the first 8 bytes of its header (reserved, optionFlags,
 * numGlyphs, indexFormat), the substreams, and what follows them, the overlapSimpleBitmap.
 */
export type GlyfParts = {
    header: Uint8Array;
    streams: Record<GlyfStream, Uint8Array>;
    tail: Uint8Array;
};

/**
 * One more glyph at the end of a transformed glyf, a composite: its component flags and
 * arguments as compositeStream holds them, its bounding box unless it lacks one, and its
 * instruction length as a 255UInt16 with the instructions when a component flag calls for them.
 */
export type Composite = {
    components: Uint8Array;
    boundingBox: Uint8Array | undefined;
    instructionLength?: Uint8Array;
    instructions?: Uint8Array;
};

export async function readFixture(): Promise<Uint8Array> {
    return await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF2}`));
}

/**
 * Reads a WOFF2 into a layout: the header fields it keeps, the entries with the bytes each takes
 * from the decompressed stream. The fixture has no metadata and no private block.
 */
export function parse(woff2: Uint8Array): Layout {
    const entries: Array<Entry> = [];
    let offset = HEADER_SIZE_BYTES;

    const readBase128 = (): number => {
        let value = 0;
        let byte: number;

        do {
            byte = readUint8(woff2, offset);
            offset += 1;
            value = value * 128 + (byte & 0x7f);
        } while ((byte & 0x80) !== 0);

        return value;
    };

    for (let index = 0; index < readUint16(woff2, NUM_TABLES); index++) {
        const flags = readUint8(woff2, offset);
        const isTagExplicit = (flags & 0x3f) === ARBITRARY_TAG_INDEX;
        const tag = isTagExplicit ? Buffer.from(woff2.subarray(offset + 1, offset + 5)).toString("latin1") : KNOWN_TAGS[flags & 0x3f] ?? "";

        offset += isTagExplicit ? 5 : 1;

        const transformVersion = flags >> 6;
        const origLength = readBase128();
        const isTransformed = ["glyf", "loca"].includes(tag) ? transformVersion === 0 : transformVersion !== 0;

        entries.push({
            tag: tag,
            transformVersion: transformVersion,
            isTagExplicit: isTagExplicit,
            origLength: origLength,
            transformLength: isTransformed ? readBase128() : undefined,
            data: new Uint8Array(0),
        });
    }

    const decompressed = zlib.brotliDecompressSync(woff2.subarray(offset, offset + readUint32(woff2, TOTAL_COMPRESSED_SIZE)));
    let streamOffset = 0;

    for (const entry of entries) {
        const length = entry.transformLength ?? entry.origLength;

        entry.data = decompressed.subarray(streamOffset, streamOffset + length);
        streamOffset += length;
    }

    return {
        flavor: readUint32(woff2, FLAVOR),
        reserved: readUint16(woff2, RESERVED),
        totalSfntSize: readUint32(woff2, TOTAL_SFNT_SIZE),
        entries: entries,
    };
}

export function tableOf(layout: Layout, tag: string): Uint8Array {
    const entry = layout.entries.find((candidate) => candidate.tag === tag);

    return entry?.data ?? expect.fail(`no table ${tag}`);
}

export function splitGlyf(glyf: Uint8Array): GlyfParts {
    const streams: Partial<Record<GlyfStream, Uint8Array>> = {};
    let offset = GLYF_HEADER_SIZE_BYTES;

    for (const [index, name] of GLYF_STREAMS.entries()) {
        const sizeBytes = readUint32(glyf, GLYF_N_CONTOUR_STREAM_SIZE + 4 * index);

        streams[name] = glyf.subarray(offset, offset + sizeBytes);
        offset += sizeBytes;
    }

    return {
        header: glyf.subarray(0, GLYF_N_CONTOUR_STREAM_SIZE),
        streams: streams as Record<GlyfStream, Uint8Array>,
        tail: glyf.subarray(offset),
    };
}

/**
 * The transformed glyf of `parts`, the size of each substream in its header.
 */
export function joinGlyf({ header, streams, tail }: GlyfParts): Uint8Array {
    const sizes = new DataView(new ArrayBuffer(4 * GLYF_STREAMS.length));

    for (const [index, name] of GLYF_STREAMS.entries()) {
        sizes.setUint32(4 * index, streams[name].length);
    }

    return concat(header, new Uint8Array(sizes.buffer), ...GLYF_STREAMS.map((name) => streams[name]), tail);
}

/**
 * The parts with one stream as `edit` makes it.
 */
export function withStream(parts: GlyfParts, name: GlyfStream, edit: (stream: Uint8Array) => Uint8Array): GlyfParts {
    return { ...parts, streams: { ...parts.streams, [name]: edit(parts.streams[name]) } };
}

/**
 * The parts with nContour of `glyph` set to `nContour`.
 */
export function withNContour(parts: GlyfParts, glyph: number, nContour: number): GlyfParts {
    return withStream(parts, "nContour", (stream) => withUint16(stream, 2 * glyph, nContour & 0xffff));
}

/**
 * The parts with the bit of `glyph` in bboxBitmap set. The explicit bounding boxes after the bitmap
 * stay as they are.
 */
export function withBoundingBoxBitSet(parts: GlyfParts, glyph: number): GlyfParts {
    return withStream(parts, "bbox", (stream) => {
        const copy = Uint8Array.from(stream);
        const index = Math.floor(glyph / 8);

        copy[index] = (copy[index] ?? 0) | (0x80 >> glyph % 8);

        return copy;
    });
}

/**
 * The parts with `composite` added as the last glyph. The substreams hold the glyphs in order, so
 * its records go at their ends. The bitmap of 1296 glyphs takes 41 words, and so does that of 1297.
 */
export function withComposite(parts: GlyfParts, composite: Composite): GlyfParts {
    const glyph = readUint16(parts.header, GLYF_NUM_GLYPHS);
    let withGlyph: GlyfParts = { ...parts, header: withUint16(parts.header, GLYF_NUM_GLYPHS, glyph + 1) };

    withGlyph = withStream(withGlyph, "nContour", (stream) => concat(stream, Uint8Array.from([0xff, 0xff])));
    withGlyph = withStream(withGlyph, "composite", (stream) => concat(stream, composite.components));
    withGlyph = withStream(withGlyph, "glyph", (stream) => concat(stream, composite.instructionLength ?? new Uint8Array(0)));
    withGlyph = withStream(withGlyph, "instruction", (stream) => concat(stream, composite.instructions ?? new Uint8Array(0)));

    if (composite.boundingBox === undefined) {
        return withGlyph;
    }

    const boundingBox = composite.boundingBox;

    return withStream(withBoundingBoxBitSet(withGlyph, glyph), "bbox", (stream) => concat(stream, boundingBox));
}

/**
 * A composite of glyphs 5 and 6 of the fixture in four components, one for each size of the
 * arguments: words, a scale, an x and a y scale, a 2 × 2 matrix. 40 bytes of compositeStream, and
 * the bounding box xMin 10, yMin −20, xMax 900, yMax 1400.
 */
export function composite(): Composite {
    return {
        components: Uint8Array.from([
            // ARG_1_AND_2_ARE_WORDS, ARGS_ARE_XY_VALUES, MORE_COMPONENTS; glyph 5; dx 16, dy 32.
            ...[0x00, 0x23, 0x00, 0x05, 0x00, 0x10, 0x00, 0x20],
            // ARGS_ARE_XY_VALUES, WE_HAVE_A_SCALE, MORE_COMPONENTS; glyph 6; dx 1, dy 2; scale 1.0.
            ...[0x00, 0x2a, 0x00, 0x06, 0x01, 0x02, 0x40, 0x00],
            // ARGS_ARE_XY_VALUES, WE_HAVE_AN_X_AND_Y_SCALE, MORE_COMPONENTS; glyph 5; dx 3, dy 4; 1.0, 0.5.
            ...[0x00, 0x62, 0x00, 0x05, 0x03, 0x04, 0x40, 0x00, 0x20, 0x00],
            // ARGS_ARE_XY_VALUES, WE_HAVE_A_TWO_BY_TWO; glyph 6; dx 5, dy 6; the identity.
            ...[0x00, 0x82, 0x00, 0x06, 0x05, 0x06, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00],
        ]),
        boundingBox: Uint8Array.from([0x00, 0x0a, 0xff, 0xec, 0x03, 0x84, 0x05, 0x78]),
    };
}

/**
 * Bytes that stand for garbage, the same in every run: the next of a linear congruential sequence
 * modulo 256 for each byte.
 */
export function garbage(lengthBytes: number): Uint8Array {
    return Uint8Array.from({ length: lengthBytes }, (_, index) => (index * 167 + 13) % 256);
}

export function readUint16(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

export function readUint32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

export function withUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint16(offset, value);

    return copy;
}

export function withUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint32(offset, value);

    return copy;
}

export function withBytes(bytes: Uint8Array, offset: number, replacement: ArrayLike<number>): Uint8Array {
    const copy = Uint8Array.from(bytes);

    copy.set(replacement, offset);

    return copy;
}

export function concat(...parts: Array<Uint8Array>): Uint8Array {
    return Buffer.concat(parts);
}
