import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import { InvalidEotPayload } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder.errors";
import { InvalidSfnt } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { TTEMBED_TTCOMPRESSED, TTEMBED_XORENCRYPTDATA, xor } from "test/font-convertor/eot-font-data.helper";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The offsets of the EOT header fields the spec reads and edits one by one, and the length of the
// fixed part of the header, up to FamilyNameSize.
const EOT_SIZE_OFFSET = 0;
const EOT_FONT_DATA_SIZE_OFFSET = 4;
const EOT_VERSION_OFFSET = 8;
const EOT_FLAGS_OFFSET = 12;
const EOT_ITALIC_OFFSET = 27;
const EOT_FS_TYPE_OFFSET = 32;
const EOT_MAGIC_OFFSET = 34;
const EOT_UNICODE_RANGE_OFFSET = 36;
const EOT_HEADER_FIXED_SIZE = 82;
const FIXTURE_GLYPH_COUNT = 1296;
// MicroType Express rebuilds these tables, so they differ from the font the envelope was made of
// in bytes while holding the same glyphs. In head of this fixture it rewrites only
// checkSumAdjustment, which sums the whole font; with a glyf past 131070 bytes it would also switch
// indexToLocFormat to the long format.
const MTX_REBUILT_TABLES = ["glyf", "loca"];
const HEAD_CHECKSUM_ADJUSTMENT_OFFSET = 8;
const HEAD_CHECKSUM_ADJUSTMENT_SIZE_BYTES = 4;
const eotPacker = new EotPacker(new EotPayloadDecoder());

describe("EotPacker", function () {
    let workDir: string;
    let ttf: Uint8Array;
    let eot: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
        eot = await readFixture(Extension.EOT);
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eot-packer-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    describe("pack", function () {
        it("wraps the font into the envelope ttf2eot produces for it", async function () {
            // The EOT fixture was made from the TTF fixture by the third-party ttf2eot. So a
            // byte-for-byte match with it checks conformance to the format, not to ourselves.
            //
            // We differ from ttf2eot in exactly one field, fsType. ttf2eot always writes zero
            // there, declaring any font free to install. By the specification the field repeats
            // OS/2.fsType, and we take it from there. So the real value is put into the reference
            // before the comparison.
            const expected = Uint8Array.from(eot);
            new DataView(expected.buffer).setUint16(EOT_FS_TYPE_OFFSET, fontFsType(ttf), true);

            expect(hex(await pack(ttf))).to.equal(hex(expected));
        });

        it("carries the embedding permissions of the font into the envelope", async function () {
            // An EOT reader checks fsType at offset 32 before installing the font. Roboto-Black
            // has 8 there: "may be embedded, may not be installed".
            const packed = await pack(ttf);

            expect(new DataView(packed.buffer, packed.byteOffset).getUint16(EOT_FS_TYPE_OFFSET, true)).to.equal(fontFsType(ttf));
            expect(fontFsType(ttf)).to.equal(8);
        });

        it("produces a file the EOT validator accepts", async function () {
            const packedPath = path.join(workDir, `validated.${Extension.EOT}`);

            await fs.writeFile(packedPath, await pack(ttf));
            await new EotFontValidator(new SfntFontValidator(), new EotPayloadDecoder()).validate(packedPath);
        });

        it("carries the italic flag of the font into the envelope", async function () {
            // The slant is one of the fields the envelope reads the font for at all. The Italic
            // byte lies in the header at offset 27.
            const italic = Uint8Array.from(ttf);
            new DataView(italic.buffer).setUint16(os2Offset(ttf) + 62, 0x0001);

            expect((await pack(ttf))[EOT_ITALIC_OFFSET]).to.equal(0);
            expect((await pack(italic))[EOT_ITALIC_OFFSET]).to.equal(1);
        });

        it("puts each unicode and code page range into its own place in the header", async function () {
            // The comparison with ttf2eot would miss a range written to the wrong place: the
            // fixture has UnicodeRange4 and CodePageRange2 at zero, and zero would land on zero.
            // In OS/2 the ranges lie in two pieces, in the EOT header they are contiguous.
            const ranges = [0x0102_0304, 0x0506_0708, 0x090a_0b0c, 0x0d0e_0f10, 0x1112_1314, 0x1516_1718];
            const font = Uint8Array.from(ttf);
            const view = new DataView(font.buffer);
            ranges.slice(0, 4).forEach((range, index) => view.setUint32(os2Offset(ttf) + 42 + index * 4, range));
            ranges.slice(4).forEach((range, index) => view.setUint32(os2Offset(ttf) + 78 + index * 4, range));

            const packed = new DataView((await pack(font)).buffer);

            expect(ranges.map((_range, index) => packed.getUint32(EOT_UNICODE_RANGE_OFFSET + index * 4, true))).to.deep.equal(ranges);
        });

        it("leaves the font data untouched", async function () {
            const packed = await pack(ttf);

            expect(hex(packed.subarray(packed.length - ttf.length))).to.equal(hex(ttf));
        });

        it("rejects a file that is not sfnt", async function () {
            const svg = await readFixture(Extension.SVG);

            await expectRejects(() => pack(svg), InvalidSfnt);
        });
    });

    describe("unpack", function () {
        it("returns the font the envelope was made of", async function () {
            const unpacked = await unpack(eot);

            expect(hex(unpacked)).to.equal(hex(ttf));
        });

        it("undoes pack for every supported sfnt fixture", async function () {
            for (const extension of [Extension.TTF, Extension.OTF]) {
                const font = await readFixture(extension);

                expect(hex(await unpack(await pack(font))), extension).to.equal(hex(font));
            }
        });

        it("returns the font of a version 1.0 envelope, which has no root string", async function () {
            // In version 1.0 the header ends with the full name, and the font follows the names
            // directly. So the fixture's RootString block is cut out: Padding5 and RootStringSize,
            // the string itself is empty. Read as 0x00020001, such an envelope would reach into the
            // font with a fifth block.
            const rootStringStart = eot.length - ttf.length - 4;
            const legacy = Uint8Array.from(Buffer.concat([eot.subarray(0, rootStringStart), ttf]));
            const view = new DataView(legacy.buffer);
            view.setUint32(EOT_SIZE_OFFSET, legacy.length, true);
            view.setUint32(EOT_VERSION_OFFSET, 0x00010000, true);

            expect(hex(await unpack(legacy))).to.equal(hex(ttf));
        });

        it("returns the font of an envelope with a gap between the header and the font, in every version", async function () {
            // Version 0x00020002 keeps its tail (a signature, embedded EUDC) there. The tail is not
            // parsed: the header walk ends before the font start. The gap has to pass in every
            // version, not only in 0x00020002: the check does not tell versions apart.
            //
            // The 20 bytes are the fixed fields of that tail with an empty signature and no EUDC
            // font: RootStringCheckSum and EUDCCodePage (u32), Padding6 and SignatureSize (u16),
            // EUDCFlags and EUDCFontSize (u32). Zeros pass only because the tail is not read: a
            // conforming writer puts 0x50475342 into RootStringCheckSum for an empty RootString.
            // In version 1.0 the gap is 24 bytes: the walk also stops before the fixture's Padding5
            // and RootStringSize.
            const fontDataOffset = eot.length - ttf.length;
            const tail = new Uint8Array(20);

            for (const version of [0x00010000, 0x00020001, 0x00020002]) {
                const tailed = Uint8Array.from(Buffer.concat([eot.subarray(0, fontDataOffset), tail, ttf]));
                const view = new DataView(tailed.buffer);
                view.setUint32(EOT_SIZE_OFFSET, tailed.length, true);
                view.setUint32(EOT_VERSION_OFFSET, version, true);

                expect(hex(await unpack(tailed)), `0x${version.toString(16).padStart(8, "0")}`).to.equal(hex(ttf));
            }
        });

        it("rejects an envelope without the eot magic number", async function () {
            // The rest of the header is intact: without the marker check such an envelope would unpack.
            const unmarked = Uint8Array.from(eot);
            new DataView(unmarked.buffer).setUint16(EOT_MAGIC_OFFSET, 0, true);

            await expectRejects(() => unpack(unmarked), InvalidEot);
        });

        it("rejects a file cut off inside the fixed part of the header", async function () {
            // The fragment does not even reach the format marker at offset 34. Without the length
            // check, DataView would throw a RangeError instead of InvalidEot.
            await expectRejects(() => unpack(eot.subarray(0, 20)), InvalidEot);
        });

        it("rejects an envelope whose declared size does not match the file", async function () {
            // The size is edited in the header and the file stays whole. A truncated file would
            // not pin this check: its font start moves too, and the rejection would come from
            // matching the names against it.
            const misdeclared = Uint8Array.from(eot);
            new DataView(misdeclared.buffer).setUint32(EOT_SIZE_OFFSET, eot.length + 1, true);

            await expectRejects(() => unpack(misdeclared), InvalidEot);
        });

        it("rejects an envelope of an unknown version", async function () {
            const unknown = Uint8Array.from(eot);
            new DataView(unknown.buffer).setUint32(EOT_VERSION_OFFSET, 0x00030000, true);

            await expectRejects(() => unpack(unknown), InvalidEot);
        });

        it("returns the glyphs of the font a compressed envelope was made of", async function () {
            // The fixture was made from the TTF fixture by sfntly (test/fixtures/fonts/README.md).
            // The decoded sfnt is another sfnt in bytes, so the glyphs are compared point by point.
            const unpacked = await unpack(Uint8Array.from(await fs.readFile(path.join(fixtureDir, "test-font-compressed.eot"))));
            const glyphs = readGlyphs(unpacked);

            expect(glyphs).to.have.lengthOf(FIXTURE_GLYPH_COUNT);
            expect(glyphs).to.deep.equal(readGlyphs(ttf));
            expect(tableTags(unpacked), "the tables of the decoded sfnt").to.deep.equal(tableTags(ttf));

            for (const tag of tableTags(ttf).filter((tableTag) => !MTX_REBUILT_TABLES.includes(tableTag))) {
                const unpackedTable = withoutCheckSumAdjustment(tag, tableBytes(unpacked, tag));

                expect(hex(unpackedTable), tag).to.equal(hex(withoutCheckSumAdjustment(tag, tableBytes(ttf, tag))));
            }
        });

        it("returns the font an encrypted envelope was made of", async function () {
            const encrypted = Uint8Array.from(eot);
            const fontDataOffset = eot.length - ttf.length;
            encrypted.set(xor(ttf), fontDataOffset);
            new DataView(encrypted.buffer).setUint32(EOT_FLAGS_OFFSET, TTEMBED_XORENCRYPTDATA, true);

            expect(hex(await unpack(encrypted))).to.equal(hex(ttf));
        });

        it("rejects an envelope whose font data does not decode under its flags", async function () {
            const compressed = Uint8Array.from(eot);
            // TTEMBED_TTCOMPRESSED over a raw sfnt: the payload is not MicroType Express data.
            new DataView(compressed.buffer).setUint32(EOT_FLAGS_OFFSET, TTEMBED_TTCOMPRESSED, true);

            await expectRejects(() => unpack(compressed), InvalidEotPayload);
        });

        it("rejects an envelope that declares no font data", async function () {
            const empty = Uint8Array.from(eot);
            new DataView(empty.buffer).setUint32(EOT_FONT_DATA_SIZE_OFFSET, 0, true);

            await expectRejects(() => unpack(empty), InvalidEot);
        });

        it("rejects an envelope whose font data does not fit behind the fixed part of the header", async function () {
            // The font is one byte longer than the room behind the fixed part. The payload is
            // compared, not just the class. The overlap check against the names would reject such
            // a font start too, also with InvalidEot, but with its own payload.
            const oversized = Uint8Array.from(eot);
            const fontDataSize = oversized.length - EOT_HEADER_FIXED_SIZE + 1;
            new DataView(oversized.buffer).setUint32(EOT_FONT_DATA_SIZE_OFFSET, fontDataSize, true);

            const error = await expectRejects(() => unpack(oversized), InvalidEot);

            expect(error.payload).to.deep.equal({ fontDataSize: fontDataSize, length: oversized.length });
        });

        it("rejects an envelope whose name blocks run past the font data", async function () {
            const shifted = Uint8Array.from(eot);
            // An inflated family name eats the start of the font — that is what an envelope
            // assembled with a mistake in the header layout looks like.
            new DataView(shifted.buffer).setUint16(EOT_HEADER_FIXED_SIZE, 0x0400, true);

            await expectRejects(() => unpack(shifted), InvalidEot);
        });

        it("rejects an envelope whose root string runs past the font data", async function () {
            // From version 0x00020001 the names are followed by a fifth block, RootString, and it
            // is matched against the font start the same way. The fixture's string is empty, and
            // its size is the last two bytes before the font.
            const rooted = Uint8Array.from(eot);
            new DataView(rooted.buffer).setUint16(eot.length - ttf.length - 2, 0x0400, true);

            await expectRejects(() => unpack(rooted), InvalidEot);
        });

        it("rejects an envelope that ends inside a name size", async function () {
            // The file breaks off at the first byte of StyleNameSize, while the sizes in the header
            // agree with the file length: the font gets four bytes. This is not an overlap with the
            // font but a read past the end of the buffer. Without its own check, DataView would
            // throw a RangeError. The break falls on the size itself, not on the name after it:
            // otherwise the test could not tell a check shifted by a couple of bytes.
            const familyNameSize = new DataView(eot.buffer).getUint16(EOT_HEADER_FIXED_SIZE, true);
            const cut = Uint8Array.from(eot.subarray(0, EOT_HEADER_FIXED_SIZE + 2 + familyNameSize + 2 + 1));
            const view = new DataView(cut.buffer);
            view.setUint32(EOT_SIZE_OFFSET, cut.length, true);
            view.setUint32(EOT_FONT_DATA_SIZE_OFFSET, 4, true);

            await expectRejects(() => unpack(cut), InvalidEot);
        });

        it("rejects an envelope that does not hold a font", async function () {
            const stuffed = Uint8Array.from(eot);
            new DataView(stuffed.buffer).setUint32(stuffed.length - ttf.length, 0xdeadbeef);

            await expectRejects(() => unpack(stuffed), InvalidSfnt);
        });
    });

    async function expectRejects<T extends Error>(call: () => Promise<unknown>, expected: new (...params: never) => T): Promise<T> {
        try {
            await call();
            expect.fail(`call did not throw ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);

            return error as T;
        }
    }

    async function pack(font: Uint8Array): Promise<Uint8Array> {
        const fontPath = path.join(workDir, `source.${Extension.TTF}`);
        const eotPath = path.join(workDir, `packed.${Extension.EOT}`);

        await fs.writeFile(fontPath, font);
        await eotPacker.pack(fontPath, eotPath);

        return Uint8Array.from(await fs.readFile(eotPath));
    }

    async function unpack(envelope: Uint8Array): Promise<Uint8Array> {
        const eotPath = path.join(workDir, `source.${Extension.EOT}`);
        const fontPath = path.join(workDir, `unpacked.${Extension.TTF}`);

        await fs.writeFile(eotPath, envelope);
        await eotPacker.unpack(eotPath, fontPath);

        return Uint8Array.from(await fs.readFile(fontPath));
    }
});

describe("InvalidEot", function () {
    // The factories are checked directly. The unpack() specs above pin the class of the
    // rejection, not the text: which check rejected the input is not a requirement
    // (docs/architecture/testing.md, "Working through survivors"). The hexadecimal values have
    // leading zeros: the field is printed at full width.
    const cases = [
        {
            name: "InvalidEot.tooShort",
            error: InvalidEot.tooShort(20),
            type: InvalidEot,
            message: "Eot font is too short: 20 bytes.",
            payload: { length: 20 },
        },
        {
            name: "InvalidEot.invalidMagic",
            error: InvalidEot.invalidMagic(0x4c),
            type: InvalidEot,
            message: "Eot magic number is 0x004c, expected 0x504c.",
            payload: { magic: 0x4c },
        },
        {
            name: "InvalidEot.unknownVersion",
            error: InvalidEot.unknownVersion(0x00030000),
            type: InvalidEot,
            message: "Unknown eot version: 0x00030000.",
            payload: { version: 0x00030000 },
        },
        {
            name: "InvalidEot.sizeMismatch",
            error: InvalidEot.sizeMismatch(1025, 1024),
            type: InvalidEot,
            message: "Eot declares 1025 bytes, file has 1024.",
            payload: { declared: 1025, actual: 1024 },
        },
        {
            name: "InvalidEot.invalidFontDataSize",
            error: InvalidEot.invalidFontDataSize(0, 1024),
            type: InvalidEot,
            message: "Eot declares 0 bytes of font data, which does not fit into 1024 bytes.",
            payload: { fontDataSize: 0, length: 1024 },
        },
        {
            name: "InvalidEot.headerOverlapsFontData",
            error: InvalidEot.headerOverlapsFontData(1200, 1100),
            type: InvalidEot,
            message: "Eot header ends at 1200, past the font data start at 1100.",
            payload: { headerEnd: 1200, fontDataOffset: 1100 },
        },
    ];

    for (const { name, error, type, message, payload } of cases) {
        it(`${name} keeps its message and details`, function () {
            expect(error).to.be.instanceOf(type);
            expect(error.message).to.equal(message);
            expect(error.payload).to.deep.equal(payload);
        });
    }
});

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

function os2Offset(bytes: Uint8Array): number {
    return tableOffset(bytes, "OS/2");
}

/**
 * The font's fsType: in OS/2 it lies at offset 8.
 */
function fontFsType(bytes: Uint8Array): number {
    return new DataView(bytes.buffer).getUint16(os2Offset(bytes) + 8);
}

/**
 * The offset of a table record in the sfnt directory.
 */
function tableRecord(bytes: Uint8Array, tag: string): number {
    const index = tableTags(bytes).indexOf(tag);

    if (index === -1) {
        throw new Error(`Fixture has no ${tag} table.`);
    }

    return SFNT_HEADER_SIZE_BYTES + index * TABLE_RECORD_SIZE_BYTES;
}

/**
 * A simple glyph as its points lie, whatever bytes encode them: the ends of the contours, the
 * instructions and each point as `x,y,onCurve` in font units (OpenType 1.9.1, glyf). An empty glyph
 * is `undefined`. The bounding box is left out: MicroType Express computes it from the points, while
 * the TTF fixture keeps a box one unit wider than its points on some glyphs.
 */
type Glyph =
    | {
          endPoints: Array<number>;
          instructions: string;
          points: Array<string>;
      }
    | undefined;

// The sfnt table directory: a 12-byte header with numTables at offset 4, then 16-byte records with
// the tag, the offset of the table at 8 and its length at 12.
const SFNT_HEADER_SIZE_BYTES = 12;
const NUM_TABLES_OFFSET = 4;
const TABLE_RECORD_SIZE_BYTES = 16;
const TAG_SIZE_BYTES = 4;
const TABLE_OFFSET_FIELD_OFFSET = 8;
const TABLE_LENGTH_FIELD_OFFSET = 12;
// The fields the walk reads, by their offset in head and maxp, the size of numberOfContours with
// the bounding box that open a glyph, and the size of a loca entry in either format.
const INDEX_TO_LOC_FORMAT_OFFSET = 50;
const NUM_GLYPHS_OFFSET = 4;
const GLYPH_HEADER_SIZE_BYTES = 10;
const LONG_LOCA_ENTRY_SIZE_BYTES = 4;
const SHORT_LOCA_ENTRY_SIZE_BYTES = 2;
const SHORT_LOCA_OFFSET_FACTOR = 2;
const UINT16_SIZE_BYTES = 2;
// The bits of a point's flags.
const ON_CURVE_POINT = 0x01;
const X_SHORT_VECTOR = 0x02;
const Y_SHORT_VECTOR = 0x04;
const REPEAT_FLAG = 0x08;
const X_IS_SAME_OR_POSITIVE_X_SHORT_VECTOR = 0x10;
const Y_IS_SAME_OR_POSITIVE_Y_SHORT_VECTOR = 0x20;

/**
 * The two flag bits that say how one coordinate of a point is stored.
 */
type CoordinateBits = {
    isShort: number;
    isSameOrPositive: number;
};

const X_BITS: CoordinateBits = { isShort: X_SHORT_VECTOR, isSameOrPositive: X_IS_SAME_OR_POSITIVE_X_SHORT_VECTOR };
const Y_BITS: CoordinateBits = { isShort: Y_SHORT_VECTOR, isSameOrPositive: Y_IS_SAME_OR_POSITIVE_Y_SHORT_VECTOR };

function readGlyphs(font: Uint8Array): Array<Glyph> {
    const view = viewOf(font);
    const glyfOffset = tableOffset(font, "glyf");
    const locaOffset = tableOffset(font, "loca");
    const isLongLoca = view.getInt16(tableOffset(font, "head") + INDEX_TO_LOC_FORMAT_OFFSET) === 1;
    const numGlyphs = view.getUint16(tableOffset(font, "maxp") + NUM_GLYPHS_OFFSET);
    const glyphs: Array<Glyph> = [];

    // The long format keeps each offset as is, the short one keeps it halved (OpenType 1.9.1, loca).
    const locaEntry = (index: number): number =>
        isLongLoca
            ? view.getUint32(locaOffset + index * LONG_LOCA_ENTRY_SIZE_BYTES)
            : view.getUint16(locaOffset + index * SHORT_LOCA_ENTRY_SIZE_BYTES) * SHORT_LOCA_OFFSET_FACTOR;

    for (let index = 0; index < numGlyphs; index++) {
        const start = locaEntry(index);
        const end = locaEntry(index + 1);

        glyphs.push(start === end ? undefined : readGlyph(view, glyfOffset + start));
    }

    return glyphs;
}

function readGlyph(view: DataView, offset: number): Glyph {
    const numberOfContours = view.getInt16(offset);

    if (numberOfContours < 0) {
        return expect.fail("the fixture has no composite glyphs, and the spec does not read them");
    }

    const endPoints: Array<number> = [];
    let cursor = offset + GLYPH_HEADER_SIZE_BYTES;

    for (let contour = 0; contour < numberOfContours; contour++) {
        endPoints.push(view.getUint16(cursor));
        cursor += UINT16_SIZE_BYTES;
    }

    const instructionLength = view.getUint16(cursor);
    cursor += UINT16_SIZE_BYTES;
    const instructions = Buffer.from(view.buffer, view.byteOffset + cursor, instructionLength).toString("hex");
    cursor += instructionLength;

    const pointCount = (endPoints.at(-1) ?? -1) + 1;
    const flags: Array<number> = [];

    while (flags.length < pointCount) {
        const flag = view.getUint8(cursor++);
        const repeatCount = (flag & REPEAT_FLAG) === 0 ? 0 : view.getUint8(cursor++);

        for (let repeat = 0; repeat <= repeatCount; repeat++) {
            flags.push(flag);
        }
    }

    const xs = readCoordinates(view, cursor, flags, X_BITS);
    const ys = readCoordinates(view, xs.cursor, flags, Y_BITS);
    const points = flags.map((flag, index) => `${xs.values[index]},${ys.values[index]},${(flag & ON_CURVE_POINT) !== 0}`);

    return { endPoints: endPoints, instructions: instructions, points: points };
}

/**
 * One coordinate per point, made absolute from the deltas, and the cursor past them. A short delta
 * is one unsigned byte whose sign is the second bit; without the short bit that bit means "the same
 * as the previous point", otherwise an int16 delta follows.
 */
function readCoordinates(
    view: DataView,
    start: number,
    flags: Array<number>,
    bits: CoordinateBits,
): { values: Array<number>; cursor: number } {
    const values: Array<number> = [];
    let cursor = start;
    let value = 0;

    for (const flag of flags) {
        if ((flag & bits.isShort) !== 0) {
            const delta = view.getUint8(cursor++);
            value += (flag & bits.isSameOrPositive) === 0 ? -delta : delta;
        } else if ((flag & bits.isSameOrPositive) === 0) {
            value += view.getInt16(cursor);
            cursor += UINT16_SIZE_BYTES;
        }

        values.push(value);
    }

    return { values: values, cursor: cursor };
}

function withoutCheckSumAdjustment(tag: string, table: Uint8Array): Uint8Array {
    if (tag !== "head") {
        return table;
    }

    const end = HEAD_CHECKSUM_ADJUSTMENT_OFFSET + HEAD_CHECKSUM_ADJUSTMENT_SIZE_BYTES;

    return Uint8Array.from(table).fill(0, HEAD_CHECKSUM_ADJUSTMENT_OFFSET, end);
}

/**
 * The tags of the sfnt table directory, in its order.
 */
function tableTags(font: Uint8Array): Array<string> {
    const tags: Array<string> = [];

    for (let index = 0; index < viewOf(font).getUint16(NUM_TABLES_OFFSET); index++) {
        const record = SFNT_HEADER_SIZE_BYTES + index * TABLE_RECORD_SIZE_BYTES;

        tags.push(String.fromCharCode(...font.subarray(record, record + TAG_SIZE_BYTES)));
    }

    return tags;
}

function tableOffset(font: Uint8Array, tag: string): number {
    return viewOf(font).getUint32(tableRecord(font, tag) + TABLE_OFFSET_FIELD_OFFSET);
}

function tableBytes(font: Uint8Array, tag: string): Uint8Array {
    const start = tableOffset(font, tag);
    const lengthBytes = viewOf(font).getUint32(tableRecord(font, tag) + TABLE_LENGTH_FIELD_OFFSET);

    return font.subarray(start, start + lengthBytes);
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
