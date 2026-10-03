import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import type { InvalidSfntFont } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { ReadFailed } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const validator = new SfntFontValidator();

const HEADER_SIZE_BYTES = 12;
const RECORD_SIZE_BYTES = 16;

// The header fields by their offset (OpenType 1.9.1, Table Directory).
const VERSION_OFFSET_BYTES = 0;
const NUM_TABLES_OFFSET_BYTES = 4;
const SEARCH_RANGE_OFFSET_BYTES = 6;
const ENTRY_SELECTOR_OFFSET_BYTES = 8;
const RANGE_SHIFT_OFFSET_BYTES = 10;
// The fields of a table record by their offset in it: the tag opens it.
const TAG_SIZE_BYTES = 4;
const CHECKSUM_OFFSET_BYTES = 4;
const TABLE_OFFSET_OFFSET_BYTES = 8;
const LENGTH_OFFSET_BYTES = 12;
// The fields of head, maxp and hhea by their offset in the table (OpenType 1.9.1, head, maxp, hhea).
const CHECKSUM_ADJUSTMENT_OFFSET_BYTES = 8;
const MAJOR_VERSION_OFFSET_BYTES = 0;
const MAGIC_NUMBER_OFFSET_BYTES = 12;
const UNITS_PER_EM_OFFSET_BYTES = 18;
const INDEX_TO_LOC_FORMAT_OFFSET_BYTES = 50;
const MAXP_VERSION_OFFSET_BYTES = 0;
const NUM_GLYPHS_OFFSET_BYTES = 4;
const NUMBER_OF_H_METRICS_OFFSET_BYTES = 34;
// The width of a loca offset by head.indexToLocFormat: 0 is short, 1 is long.
const SHORT_LOCA_ENTRY_SIZE_BYTES = 2;
const LONG_LOCA_ENTRY_SIZE_BYTES = 4;
// The short format stores the offset divided by 2.
const SHORT_LOCA_OFFSET_FACTOR = 2;
// The fields of a glyph by their offset from its start (OpenType 1.9.1, glyf).
const NUMBER_OF_CONTOURS_OFFSET_BYTES = 0;
const GLYPH_HEADER_SIZE_BYTES = 10;
const END_PTS_OFFSET_BYTES = GLYPH_HEADER_SIZE_BYTES;
const END_PT_SIZE_BYTES = 2;
// Glyph 0 of the TrueType fixture, .notdef, is 84 bytes long by loca: a simple glyph of 5 contours
// and 16 points. instructionLength 0 lies at 20, the flags from 22 to 38, the first of them repeated
// with its repeat count 1 at 23, the x coordinates up to 60 and the y coordinates up to 81. 3 bytes
// of padding follow. Glyphs 1 and 2 have no outline: their loca offsets equal the end of glyph 0.
const GLYPH_0_LENGTH_BYTES = 84;
const GLYPH_0_NUMBER_OF_CONTOURS = 5;
const GLYPH_0_NUMBER_OF_POINTS = 16;
// endPtsOfContours[0]: the first contour ends at point 3.
const GLYPH_0_FIRST_END_PT = 3;
const GLYPH_0_INSTRUCTION_LENGTH_OFFSET_BYTES = 20;
const GLYPH_0_FLAGS_OFFSET_BYTES = 22;
const GLYPH_0_REPEAT_COUNT_OFFSET_BYTES = 23;
// The first flag stands for points 0 and 1, so the second stored flag, at 24, opens point 2.
const GLYPH_0_SECOND_FLAG_OFFSET_BYTES = 24;
const GLYPH_0_X_COORDINATES_END_BYTES = 60;
const GLYPH_0_Y_COORDINATES_END_BYTES = 81;
// More contours than glyph 0 has room for: their 2-byte ends alone run to byte 90 of its 84.
const CONTOURS_PAST_GLYPH_0 = 40;
// The flags of a component and the widths they give (OpenType 1.9.1, glyf, Composite Glyph
// Description). The TrueType fixture has no composite glyph, so the specs build them.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;
// Bits 4, 13, 14 and 15, which the specification reserves.
const RESERVED_COMPONENT_FLAGS = 0xe010;
// A component opens with its flags and glyphIndex.
const COMPONENT_FLAGS_OFFSET_BYTES = 0;
const COMPONENT_GLYPH_INDEX_OFFSET_BYTES = 2;
const COMPONENT_HEADER_SIZE_BYTES = 4;
const WORD_ARGUMENTS_SIZE_BYTES = 4;
const BYTE_ARGUMENTS_SIZE_BYTES = 2;
const TRANSFORM_FLAGS = WE_HAVE_A_SCALE | WE_HAVE_AN_X_AND_Y_SCALE | WE_HAVE_A_TWO_BY_TWO;
const TRANSFORM_SIZES_BYTES = new Map([
    [0, 0],
    [WE_HAVE_A_SCALE, 2],
    [WE_HAVE_AN_X_AND_Y_SCALE, 4],
    [WE_HAVE_A_TWO_BY_TWO, 8],
]);
const NUM_INSTR_SIZE_BYTES = 2;
// Two bytes of instructions for a composite glyph, PUSHB[0] and its byte; no rule reads their values.
const COMPOSITE_INSTRUCTIONS = [0xb0, 0x00];
// Composite glyphs 1 to 27, each of two components pointing at the next one, reach glyph 27 through
// 2^26 chains of components. A walk that followed a glyph again on every chain takes about 18 s there
// in the application image, past the 2 s mocha timeout; one that follows each composite glyph once
// takes 53 steps.
const CHAIN_OF_DOUBLED_COMPONENTS_LENGTH = 27;
// A component compositeGlyph builds, ARGS_ARE_XY_VALUES and MORE_COMPONENTS added to its flags.
type Component = { glyphIndex: number; flags: number };
// A deterministic fill for glyf: the top byte of the index times Knuth's multiplicative hash constant.
const GARBAGE_MULTIPLIER = 2654435761;
const GARBAGE_SHIFT = 24;
// cmap, name, OS/2 and post open with their version (OpenType 1.9.1, cmap, name, OS/2, post).
const TABLE_VERSION_OFFSET_BYTES = 0;
const CMAP_NUM_TABLES_OFFSET_BYTES = 2;
const CMAP_HEADER_SIZE_BYTES = 4;
const ENCODING_RECORD_SIZE_BYTES = 8;
const SUBTABLE_OFFSET_IN_RECORD_BYTES = 4;
// Every cmap subtable opens with its 2-byte format. By format, where its length lies and how wide it
// is: formats 0 to 6 give 16 bits right after the format, 8 to 13 32 bits after a reserved field, 14
// 32 bits right after the format. The header ends with the length.
const SUBTABLE_FORMAT_SIZE_BYTES = 2;
const SHORT_SUBTABLE_LENGTH_SIZE_BYTES = 2;
// By format, also the part of a subtable of a set size: the fields and arrays before its first
// array of a variable count (OpenType 1.9.1, cmap).
const SHORT_LENGTH_FIELD = { offsetBytes: 2, sizeBytes: 2 };
const LONG_LENGTH_FIELD = { offsetBytes: 4, sizeBytes: 4 };
const VARIATION_LENGTH_FIELD = { offsetBytes: 2, sizeBytes: 4 };
const SUBTABLE_LAYOUTS = new Map([
    [0, { lengthField: SHORT_LENGTH_FIELD, fixedSizeBytes: 262 }],
    [2, { lengthField: SHORT_LENGTH_FIELD, fixedSizeBytes: 518 }],
    [4, { lengthField: SHORT_LENGTH_FIELD, fixedSizeBytes: 14 }],
    [6, { lengthField: SHORT_LENGTH_FIELD, fixedSizeBytes: 10 }],
    [8, { lengthField: LONG_LENGTH_FIELD, fixedSizeBytes: 8208 }],
    [10, { lengthField: LONG_LENGTH_FIELD, fixedSizeBytes: 20 }],
    [12, { lengthField: LONG_LENGTH_FIELD, fixedSizeBytes: 16 }],
    [13, { lengthField: LONG_LENGTH_FIELD, fixedSizeBytes: 16 }],
    [14, { lengthField: VARIATION_LENGTH_FIELD, fixedSizeBytes: 10 }],
]);
const NAME_COUNT_OFFSET_BYTES = 2;
const NAME_STORAGE_OFFSET_OFFSET_BYTES = 4;
const NAME_HEADER_SIZE_BYTES = 6;
const NAME_RECORD_SIZE_BYTES = 12;
// The fields of a name record and of a language-tag record that place its string in the storage.
const NAME_RECORD_LENGTH_OFFSET_BYTES = 8;
const NAME_RECORD_STRING_OFFSET_OFFSET_BYTES = 10;
const LANG_TAG_COUNT_SIZE_BYTES = 2;
const LANG_TAG_RECORD_SIZE_BYTES = 4;
const LANG_TAG_RECORD_LENGTH_OFFSET_BYTES = 0;
const LANG_TAG_RECORD_STRING_OFFSET_OFFSET_BYTES = 2;
const OS2_VERSION_SIZE_BYTES = 2;
const POST_HEADER_SIZE_BYTES = 32;
// Versions 2.0 and 2.5 follow the header with numGlyphs and an entry per glyph: a 2-byte
// glyphNameIndex for 2.0, a 1-byte offset for 2.5.
const POST_NUM_GLYPHS_OFFSET_BYTES = 32;
const POST_NUM_GLYPHS_SIZE_BYTES = 2;
const POST_NUM_GLYPHS_END_BYTES = POST_NUM_GLYPHS_OFFSET_BYTES + POST_NUM_GLYPHS_SIZE_BYTES;
const POST_GLYPH_NAMES = new Map([
    [0x00020000, { entries: "glyphNameIndex", entrySizeBytes: 2 }],
    [0x00025000, { entries: "offset", entrySizeBytes: 1 }],
]);
const GLYPH_NAME_INDEX_SIZE_BYTES = 2;
// The Macintosh glyph names of post 2.0: glyphNameIndex from this count on points into stringData.
const POST_STANDARD_NAME_COUNT = 258;
// The length the fields of each OS/2 version take, by version. A version 0 table of 68 bytes is a
// legacy one, without its last five fields.
const OS2_LENGTHS_BYTES = new Map([
    [0, 68],
    [1, 86],
    [2, 96],
    [3, 96],
    [4, 96],
    [5, 100],
]);
const POST_VERSIONS = [0x00010000, 0x00020000, 0x00025000, 0x00030000];
const POST_VERSIONS_EXPECTED = `expected one of ${POST_VERSIONS.map(hex).join(", ")}.`;

const TRUETYPE_VERSION = 0x00010000;
const CFF_VERSION = 0x4f54544f;
const COLLECTION_VERSION = 0x74746366;
const VERSIONS_EXPECTED = "expected one of 0x00010000, 0x74727565, 0x4f54544f.";
const OUTLINES_EXPECTED = 'expected "glyf" with "loca", or "CFF ".';

// The TrueType fixture: 13 tables, 158 856 bytes, FFTM the first record and the last table in the
// file. The CFF fixture: 11 tables, 95 936 bytes.
const TTF_SIZE_BYTES = 158856;
const TTF_NUM_TABLES = 13;
// Both fixtures give every glyph a 4-byte hmtx record. The TrueType one has long loca offsets, and
// its last offset is the length of glyf. Every table a length rule of head, hhea, maxp, hmtx and
// loca covers is exactly as long as its fields need: head 54, hhea 36, maxp 32 and 6, the hmtx and
// loca of the TrueType fixture. Accepting the fixtures holds each of those length rules at its
// boundary. So do OS/2, version 1 of 86 bytes in the TrueType fixture and version 3 of 96 in the CFF
// one, and post, version 3 of 32 bytes in the CFF fixture.
const TTF_NUM_GLYPHS = 1296;
const LAST_GLYPH = TTF_NUM_GLYPHS - 1;
const OTF_NUM_GLYPHS = 1295;
const TTF_GLYF_LENGTH_BYTES = 133424;
// Its glyphs up to this one end below 131 070, the largest offset the short loca format holds.
const SHORT_LOCA_NUM_GLYPHS = 1000;
const REQUIRED_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "post"];
// Both fixtures: cmap is 1182 bytes long with 3 encoding records. Records 0 and 2 point at one
// subtable, which starts right after the records; record 1 at a subtable of format 6, 522 bytes
// long, which ends the table. name is 444 bytes long with 12 name records, which end at byte 150 of
// the table, where the string storage starts; the last string, of record 5, ends at byte 443.
const CMAP_LENGTH_BYTES = 1182;
const CMAP_NUM_TABLES = 3;
const CMAP_RECORDS_END_BYTES = CMAP_HEADER_SIZE_BYTES + CMAP_NUM_TABLES * ENCODING_RECORD_SIZE_BYTES;
// The fewest encoding records that run past the end of cmap: 4 + 8 × 148 = 1188.
const CMAP_NUM_TABLES_PAST_END = Math.floor((CMAP_LENGTH_BYTES - CMAP_HEADER_SIZE_BYTES) / ENCODING_RECORD_SIZE_BYTES) + 1;
const LAST_SUBTABLE_OFFSET_BYTES = 660;
const LAST_SUBTABLE_FORMAT = 6;
// OpenType defines formats 0 to 14 without 1, 3, 5, 7, 9 and 11.
const UNDEFINED_SUBTABLE_FORMAT = 7;
const LAST_SUBTABLE_LENGTH_BYTES = CMAP_LENGTH_BYTES - LAST_SUBTABLE_OFFSET_BYTES;
// post of the TrueType fixture is version 2.0, 12925 bytes long: glyphNameIndex[1296] ends at byte
// 2626, and 1047 Pascal strings follow it up to the end of the table. Only the last glyph points at
// the last string, with the highest index, 1304; the next highest is 1303. The last string starts at
// byte 12915 with its length byte.
const TTF_POST_LENGTH_BYTES = 12925;
const TTF_POST_STRINGS_START_BYTES = POST_NUM_GLYPHS_END_BYTES + TTF_NUM_GLYPHS * GLYPH_NAME_INDEX_SIZE_BYTES;
const TTF_POST_STRING_COUNT = 1047;
const TTF_LAST_GLYPH = TTF_NUM_GLYPHS - 1;
const TTF_HIGHEST_GLYPH_NAME_INDEX = 1304;
const TTF_LAST_POST_STRING_START_BYTES = 12915;
const NAME_LENGTH_BYTES = 444;
const NAME_COUNT = 12;
const NAME_RECORDS_END_BYTES = 150;
const NAME_STRINGS_END_BYTES = 443;
// The record of the Windows full name: pointed past the table, its string crashes fontforge 20230101.
const WINDOWS_FULL_NAME_RECORD = 9;
// A string the measurement placed past the table: 40 bytes at 290 of the storage, so it ends at
// 150 + 290 + 40 = 480 of the 444-byte name.
const STRING_PAST_TABLE = { offsetBytes: 290, lengthBytes: 40 };
// An offset past the storage of any name, which the measurement gave an empty string.
const FAR_STRING_OFFSET_BYTES = 60000;
// A version 1 name without language tags (withNameVersion1) is 446 bytes long, and the fewest
// language-tag records that run past it are 74: (446 − 152) / 4 = 73.5.
const NAME_VERSION_1_LENGTH_BYTES = NAME_LENGTH_BYTES + LANG_TAG_COUNT_SIZE_BYTES;
const LANG_TAGS_PAST_END =
    Math.floor((NAME_VERSION_1_LENGTH_BYTES - NAME_RECORDS_END_BYTES - LANG_TAG_COUNT_SIZE_BYTES) / LANG_TAG_RECORD_SIZE_BYTES) + 1;

describe("SfntFontValidator", function () {
    let workDir: string;
    // The file every variant is written to: each answer names it in its payload.
    let fontPath: string;
    let ttf: Uint8Array;
    let otf: Uint8Array;

    before(async function () {
        ttf = Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${Extension.TTF}`)));
        otf = Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${Extension.OTF}`)));
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sfnt-font-validator-"));
        fontPath = path.join(workDir, `font.${Extension.TTF}`);
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    describe("accepts a valid font", function () {
        it("the TrueType fixture", async function () {
            await validate(ttf);
        });

        it("the CFF fixture", async function () {
            await validate(otf);
        });

        it("of every sfnt version the domain accepts", async function () {
            for (const version of SFNT_VERSIONS) {
                await validate(withUint32(ttf, VERSION_OFFSET_BYTES, version));
                await validate(withUint32(otf, VERSION_OFFSET_BYTES, version));
            }
        });

        it("whose version is OTTO over TrueType outlines", async function () {
            // The specification says "should" match; the rules go by the outline tables present.
            await validate(withUint32(ttf, VERSION_OFFSET_BYTES, CFF_VERSION));
        });

        it("whose version is 0x00010000 over CFF outlines", async function () {
            await validate(withUint32(otf, VERSION_OFFSET_BYTES, TRUETYPE_VERSION));
        });

        it("with CFF outlines and a stray loca or glyf", async function () {
            // A font with CFF has its outlines: a lone loca or glyf next to it is not TrueType outlines.
            for (const tag of ["loca", "glyf"]) {
                await validate(withRecordsSorted(withTag(otf, "GDEF", tag)));
            }
        });

        it("with TrueType outlines and no OS/2", async function () {
            // Apple's manual does not require OS/2 of a TrueType font (chapter 6).
            await validate(withoutTable(ttf, "OS/2"));
        });

        it("whose table checksum is wrong", async function () {
            // fontforge does not read the checksums.
            await validate(withUint32(ttf, recordOf(ttf, "glyf") + CHECKSUM_OFFSET_BYTES, 0));
            await validate(withUint32(otf, recordOf(otf, "CFF ") + CHECKSUM_OFFSET_BYTES, 0));
        });

        it("whose checkSumAdjustment is wrong", async function () {
            await validate(withUint32(ttf, tableOffset(ttf, "head") + CHECKSUM_ADJUSTMENT_OFFSET_BYTES, 0));
        });

        it("whose searchRange, entrySelector and rangeShift are wrong", async function () {
            // The specification tells readers not to rely on them.
            await validate(withUint16(ttf, SEARCH_RANGE_OFFSET_BYTES, 0));
            await validate(withUint16(ttf, ENTRY_SELECTOR_OFFSET_BYTES, 0));
            await validate(withUint16(ttf, RANGE_SHIFT_OFFSET_BYTES, 0));
        });

        it("whose unitsPerEm is at either end of 16 to 16384", async function () {
            for (const unitsPerEm of [16, 16384]) {
                await validate(withField16(ttf, "head", UNITS_PER_EM_OFFSET_BYTES, unitsPerEm));
            }
        });

        it("with fewer hmtx records than glyphs", async function () {
            // The last record applies to the rest, which carry only a left side bearing: 4 + 2 × 1295.
            await validate(withLength(withField16(ttf, "hhea", NUMBER_OF_H_METRICS_OFFSET_BYTES, 1), "hmtx", 2594));
        });

        it("with short loca offsets", async function () {
            await validate(withShortLoca(ttf));
        });

        it("whose last short offset, doubled, is the length of glyf", async function () {
            const font = withShortLoca(ttf);

            await validate(withLength(font, "glyf", lastShortOffsetBytes(font)));
        });

        it("whose loca repeats an offset, for a glyph without an outline", async function () {
            const loca = tableOffset(ttf, "loca");

            await validate(withUint32(ttf, loca + LONG_LOCA_ENTRY_SIZE_BYTES, readUint32(ttf, loca)));
        });

        it("whose simple glyph ends with its last y coordinate", async function () {
            await validate(withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_Y_COORDINATES_END_BYTES)));
        });

        it("with a simple glyph without contours", async function () {
            // The header and instructionLength 0: no points, so no flags and no coordinates.
            const header = withUint16(glyph0(ttf), NUMBER_OF_CONTOURS_OFFSET_BYTES, 0);
            const withoutContours = withUint16(header, END_PTS_OFFSET_BYTES, 0);

            await validate(withGlyph(ttf, 0, withoutContours.subarray(0, GLYPH_HEADER_SIZE_BYTES + END_PT_SIZE_BYTES)));
        });

        it("with a composite glyph of any negative numberOfContours", async function () {
            // The specification says -1 "should be used", and fontforge reads any negative value as a
            // composite glyph. setUint16 stores a negative value as its two's complement, as the signed
            // field holds it.
            const composite = compositeGlyph([{ glyphIndex: 0, flags: 0 }]);

            for (const numberOfContours of [-1, -2, -32768]) {
                await validate(withGlyph(ttf, 1, withUint16(composite, NUMBER_OF_CONTOURS_OFFSET_BYTES, numberOfContours)));
            }
        });

        it("whose composite glyph ends with its last component, of every width of arguments and transform", async function () {
            const composite = compositeGlyph([
                { glyphIndex: 0, flags: 0 },
                { glyphIndex: 0, flags: ARG_1_AND_2_ARE_WORDS | WE_HAVE_A_SCALE },
                { glyphIndex: 0, flags: WE_HAVE_AN_X_AND_Y_SCALE },
                { glyphIndex: 0, flags: ARG_1_AND_2_ARE_WORDS | WE_HAVE_A_TWO_BY_TWO },
            ]);

            await validate(withGlyph(ttf, 1, composite));
        });

        it("whose composite glyph ends with its instructions", async function () {
            await validate(withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 0, flags: WE_HAVE_INSTRUCTIONS }], COMPOSITE_INSTRUCTIONS)));
        });

        it("with a component pointing at the last glyph of maxp", async function () {
            await validate(withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: LAST_GLYPH, flags: 0 }])));
        });

        it("whose component flags set the reserved bits", async function () {
            // Real fonts set them: the class comment of SfntFontValidator gives the measurement.
            await validate(withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 0, flags: RESERVED_COMPONENT_FLAGS }])));
        });

        it("with composite glyphs nested, two chains meeting at one glyph", async function () {
            // Glyph 1 reaches glyph 3 through glyph 2 and directly: a glyph met twice, not a cycle.
            const nested = withGlyphs(ttf, [
                [
                    1,
                    compositeGlyph([
                        { glyphIndex: 2, flags: 0 },
                        { glyphIndex: 3, flags: 0 },
                    ]),
                ],
                [2, compositeGlyph([{ glyphIndex: 3, flags: 0 }])],
                [3, compositeGlyph([{ glyphIndex: 0, flags: 0 }])],
            ]);

            await validate(nested);
        });

        it("with a chain of composite glyphs each pointing twice at the next, each glyph walked once", async function () {
            const chain: Array<[number, Uint8Array]> = [];

            for (let glyphId = 1; glyphId < CHAIN_OF_DOUBLED_COMPONENTS_LENGTH; glyphId++) {
                const next = { glyphIndex: glyphId + 1, flags: 0 };

                chain.push([glyphId, compositeGlyph([next, next])]);
            }

            chain.push([CHAIN_OF_DOUBLED_COMPONENTS_LENGTH, compositeGlyph([{ glyphIndex: 0, flags: 0 }])]);

            await validate(withGlyphs(ttf, chain));
        });

        it("whose cmap subtable starts right after the encoding records, and another ends the table", async function () {
            expect(subtableOffsetOf(ttf, 0)).to.equal(CMAP_RECORDS_END_BYTES);
            expect(subtableOffsetOf(ttf, 1)).to.equal(LAST_SUBTABLE_OFFSET_BYTES);
            await validate(withSubtableHeader(ttf, LAST_SUBTABLE_FORMAT, LAST_SUBTABLE_LENGTH_BYTES));
        });

        it("whose last cmap subtable is as long as the part of its format of a set size and ends the table, in every format", async function () {
            for (const [format, { fixedSizeBytes }] of SUBTABLE_LAYOUTS) {
                await validate(withLastSubtable(ttf, format, fixedSizeBytes, fixedSizeBytes));
            }
        });

        it("whose last name string ends the table", async function () {
            await validate(withLength(ttf, "name", NAME_STRINGS_END_BYTES));
        });

        it("whose empty name string points past the table", async function () {
            // An empty string has no byte to read, and fontforge converts it at any offset.
            await validate(withNameString(ttf, WINDOWS_FULL_NAME_RECORD, FAR_STRING_OFFSET_BYTES, 0));
        });

        it("whose name holds no strings past its records", async function () {
            await validate(withLength(withField16(ttf, "name", NAME_COUNT_OFFSET_BYTES, 0), "name", NAME_HEADER_SIZE_BYTES));
        });

        it("with a version 1 name whose strings follow its language-tag records", async function () {
            await validate(withNameVersion1(ttf, 2));
        });

        it("with OS/2 of every version at the length of its fields", async function () {
            // The table is moved to the end of the file: version 5 is longer than the fixture's OS/2 and
            // would run into the next table in place.
            for (const [version, lengthBytes] of OS2_LENGTHS_BYTES) {
                await validate(withTableMovedToEnd(withField16(otf, "OS/2", TABLE_VERSION_OFFSET_BYTES, version), "OS/2", lengthBytes));
            }
        });

        it("with post 1.0 and 3.0 of its 32-byte header", async function () {
            for (const version of POST_VERSIONS.filter((postVersion) => !POST_GLYPH_NAMES.has(postVersion))) {
                await validate(withUint32(otf, tableOffset(otf, "post") + TABLE_VERSION_OFFSET_BYTES, version));
            }
        });

        it("with post 2.0 and 2.5 ending with the entry of its last glyph", async function () {
            for (const version of POST_GLYPH_NAMES.keys()) {
                await validate(withPostGlyphNames(otf, version));
            }
        });

        it("with post 2.0 and 2.5 naming more glyphs than maxp has", async function () {
            // fontforge loses nothing on a larger numGlyphs (issue #757).
            for (const version of POST_GLYPH_NAMES.keys()) {
                await validate(withPostGlyphNames(otf, version, OTF_NUM_GLYPHS + 1));
            }
        });

        it("whose post 2.0 ends with the string its highest glyphNameIndex points at", async function () {
            expect(readUint32(ttf, recordOf(ttf, "post") + LENGTH_OFFSET_BYTES)).to.equal(TTF_POST_LENGTH_BYTES);
            expect(glyphNameIndexOf(ttf, TTF_LAST_GLYPH)).to.equal(TTF_HIGHEST_GLYPH_NAME_INDEX);
            await validate(ttf);
        });

        it("whose post 2.0 string past the one its highest glyphNameIndex points at runs past the table", async function () {
            // The last glyph no longer names the last string, and the table is cut into it.
            const withoutLastName = withGlyphNameIndex(ttf, TTF_LAST_GLYPH, 0);

            await validate(withLength(withoutLastName, "post", TTF_POST_LENGTH_BYTES - 1));
        });

        it("whose last table ends at the end of the file", async function () {
            const fftm = recordOf(ttf, "FFTM");

            expect(tableOffset(ttf, "FFTM") + readUint32(ttf, fftm + LENGTH_OFFSET_BYTES)).to.equal(TTF_SIZE_BYTES);
            await validate(ttf);
        });
    });

    describe("rejects a file that is not sfnt", function () {
        it("shorter than the header", async function () {
            await expectAnswer(new Uint8Array(0), NotSfnt, "File is not sfnt: it is 0 bytes long, shorter than the 12-byte header.");
            await expectAnswer(
                ttf.subarray(0, HEADER_SIZE_BYTES - 1),
                NotSfnt,
                "File is not sfnt: it is 11 bytes long, shorter than the 12-byte header.",
            );
        });

        it("of an unknown version", async function () {
            const woff = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF}`));

            await expectAnswer(woff, NotSfnt, `File is not sfnt: its version is 0x774f4646, ${VERSIONS_EXPECTED}`);
            await expectAnswer(
                withUint32(ttf, VERSION_OFFSET_BYTES, 0x00020000),
                NotSfnt,
                `File is not sfnt: its version is 0x00020000, ${VERSIONS_EXPECTED}`,
            );
        });
    });

    describe("rejects a broken header", function () {
        it("of a collection", async function () {
            for (const font of [ttf, otf]) {
                await expectBroken(
                    withUint32(font, VERSION_OFFSET_BYTES, COLLECTION_VERSION),
                    SfntRule.Collection,
                    `At the header: sfntVersion is 0x74746366 ("ttcf"), ${VERSIONS_EXPECTED}`,
                );
            }
        });

        it("with no tables", async function () {
            await expectBroken(
                withUint16(ttf, NUM_TABLES_OFFSET_BYTES, 0),
                SfntRule.TablesPresent,
                "At the header: numTables is 0, expected at least 1.",
            );
        });

        it("of the 12-byte header alone, for the table records it lacks", async function () {
            await expectBroken(
                ttf.subarray(0, HEADER_SIZE_BYTES),
                SfntRule.DirectoryInFile,
                "At the file: size is 12, expected at least 220 for 13 table records.",
            );
        });

        it("whose table directory does not fit in the file", async function () {
            const directoryEndBytes = HEADER_SIZE_BYTES + TTF_NUM_TABLES * RECORD_SIZE_BYTES;

            await expectBroken(
                ttf.subarray(0, directoryEndBytes - 1),
                SfntRule.DirectoryInFile,
                "At the file: size is 219, expected at least 220 for 13 table records.",
            );
        });
    });

    describe("rejects a broken table directory", function () {
        it("whose tables lie past a file of the directory alone", async function () {
            const directoryEndBytes = HEADER_SIZE_BYTES + TTF_NUM_TABLES * RECORD_SIZE_BYTES;

            await expectBroken(
                ttf.subarray(0, directoryEndBytes),
                SfntRule.TableInFile,
                'At table "FFTM": offset + length is 158856, expected at most 220, the file size.',
            );
        });

        it("whose last table runs one byte past the end of the file", async function () {
            await expectBroken(
                ttf.subarray(0, TTF_SIZE_BYTES - 1),
                SfntRule.TableInFile,
                'At table "FFTM": offset + length is 158856, expected at most 158855, the file size.',
            );
        });

        it("whose table length runs past 2^32", async function () {
            // offset + length is summed as a number, not wrapped to 32 bits.
            await expectBroken(
                withUint32(ttf, recordOf(ttf, "glyf") + LENGTH_OFFSET_BYTES, 0xffffffff),
                SfntRule.TableInFile,
                'At table "glyf": offset + length is 4294979283, expected at most 158856, the file size.',
            );
        });

        it("whose numTables runs past the table records into the tables", async function () {
            // numTables + 5 crashes fontforge with SIGSEGV. The first extra record is read from the
            // start of head, whose version 1.0 is no tag after "post".
            await expectBroken(
                withUint16(ttf, NUM_TABLES_OFFSET_BYTES, TTF_NUM_TABLES + 5),
                SfntRule.AscendingTags,
                'At table "\\u0000\\u0001\\u0000\\u0000": tag is "\\u0000\\u0001\\u0000\\u0000", expected a tag after "post".',
            );
        });

        it("whose tags are out of order", async function () {
            await expectBroken(
                withSwappedRecords(ttf, 0, 1),
                SfntRule.AscendingTags,
                'At table "FFTM": tag is "FFTM", expected a tag after "GDEF".',
            );
        });

        it("with a tag twice", async function () {
            await expectBroken(
                withTag(ttf, "GDEF", "FFTM"),
                SfntRule.AscendingTags,
                'At table "FFTM": tag is "FFTM", expected a tag after "FFTM".',
            );
        });
    });

    describe("rejects a font without a table it must have", function () {
        for (const tag of REQUIRED_TAGS) {
            it(`without ${tag}`, async function () {
                for (const font of [ttf, otf]) {
                    await expectBroken(
                        withoutTable(font, tag),
                        SfntRule.RequiredTable,
                        `At the table directory: table ${JSON.stringify(tag)} is absent, expected present.`,
                    );
                }
            });
        }

        it("with CFF outlines and no OS/2", async function () {
            await expectBroken(
                withoutTable(otf, "OS/2"),
                SfntRule.Os2WithCff,
                'At the table directory: table "OS/2" is absent, expected present, as the font has "CFF ".',
            );
        });

        it("with CFF outlines and no OS/2 under the TrueType version", async function () {
            // The rule goes by the outlines present, not by the version.
            await expectBroken(
                withUint32(withoutTable(otf, "OS/2"), VERSION_OFFSET_BYTES, TRUETYPE_VERSION),
                SfntRule.Os2WithCff,
                'At the table directory: table "OS/2" is absent, expected present, as the font has "CFF ".',
            );
        });
    });

    describe("rejects a font without outlines it can take", function () {
        it("with glyf and no loca", async function () {
            await expectBroken(
                withoutTable(ttf, "loca"),
                SfntRule.Outlines,
                `At the table directory: outlines is "glyf" without "loca", ${OUTLINES_EXPECTED}`,
            );
        });

        it("with loca and no glyf", async function () {
            await expectBroken(
                withoutTable(ttf, "glyf"),
                SfntRule.Outlines,
                `At the table directory: outlines is "loca" without "glyf", ${OUTLINES_EXPECTED}`,
            );
        });

        it("with no outline tables at all", async function () {
            await expectBroken(
                withoutTable(withoutTable(ttf, "glyf"), "loca"),
                SfntRule.Outlines,
                `At the table directory: outlines is none, ${OUTLINES_EXPECTED}`,
            );
            await expectBroken(
                withoutTable(otf, "CFF "),
                SfntRule.Outlines,
                `At the table directory: outlines is none, ${OUTLINES_EXPECTED}`,
            );
        });

        it("with CFF2 outlines", async function () {
            // "CFF " sorts before "CFF2" and "CFF2" before "FFTM", so the tags stay in order.
            await expectBroken(
                withTag(otf, "CFF ", "CFF2"),
                SfntRule.NoCff2,
                'At the table directory: table "CFF2" is present, expected absent.',
            );
        });
    });

    describe("rejects a broken head", function () {
        it("shorter than its 54 bytes", async function () {
            // Declared 20 bytes long, head is converted with every glyph kept.
            for (const lengthBytes of [20, 53]) {
                await expectBroken(
                    withLength(ttf, "head", lengthBytes),
                    SfntRule.HeadLength,
                    `At table "head": length is ${lengthBytes}, expected at least 54.`,
                );
            }
        });

        it("of major version 2", async function () {
            await expectBroken(
                withField16(ttf, "head", MAJOR_VERSION_OFFSET_BYTES, 2),
                SfntRule.HeadVersion,
                'At table "head": majorVersion is 2, expected 1.',
            );
        });

        it("with a wrong magic number", async function () {
            await expectBroken(
                withUint32(ttf, tableOffset(ttf, "head") + MAGIC_NUMBER_OFFSET_BYTES, 0x5f0f3cf4),
                SfntRule.MagicNumber,
                'At table "head": magicNumber is 0x5f0f3cf4, expected 0x5f0f3cf5.',
            );
        });

        it("with unitsPerEm outside 16 to 16384", async function () {
            for (const unitsPerEm of [0, 8, 15, 16385, 40000]) {
                await expectBroken(
                    withField16(ttf, "head", UNITS_PER_EM_OFFSET_BYTES, unitsPerEm),
                    SfntRule.UnitsPerEm,
                    `At table "head": unitsPerEm is ${unitsPerEm}, expected from 16 to 16384.`,
                );
            }
        });

        it("with indexToLocFormat neither 0 nor 1", async function () {
            // indexToLocFormat 2 loses half of the glyphs in fontforge (649 of 1296).
            await expectBroken(
                withField16(ttf, "head", INDEX_TO_LOC_FORMAT_OFFSET_BYTES, 2),
                SfntRule.IndexToLocFormat,
                'At table "head": indexToLocFormat is 2, expected 0 or 1.',
            );
            // The field is signed.
            await expectBroken(
                withField16(otf, "head", INDEX_TO_LOC_FORMAT_OFFSET_BYTES, 0xffff),
                SfntRule.IndexToLocFormat,
                'At table "head": indexToLocFormat is -1, expected 0 or 1.',
            );
        });
    });

    describe("rejects a broken maxp", function () {
        it("of version 0.5 with TrueType outlines", async function () {
            await expectBroken(
                withUint32(ttf, tableOffset(ttf, "maxp") + MAXP_VERSION_OFFSET_BYTES, 0x00005000),
                SfntRule.MaxpVersion,
                'At table "maxp": version is 0x00005000, expected 0x00010000, as the font has table "glyf".',
            );
        });

        it("of version 1.0 with CFF outlines", async function () {
            await expectBroken(
                withUint32(otf, tableOffset(otf, "maxp") + MAXP_VERSION_OFFSET_BYTES, 0x00010000),
                SfntRule.MaxpVersion,
                'At table "maxp": version is 0x00010000, expected 0x00005000, as the font has table "CFF ".',
            );
        });

        it("of version 0.5 with TrueType outlines under the CFF version", async function () {
            // The rule goes by the outlines present, not by the version.
            await expectBroken(
                withUint32(
                    withUint32(ttf, tableOffset(ttf, "maxp") + MAXP_VERSION_OFFSET_BYTES, 0x00005000),
                    VERSION_OFFSET_BYTES,
                    CFF_VERSION,
                ),
                SfntRule.MaxpVersion,
                'At table "maxp": version is 0x00005000, expected 0x00010000, as the font has table "glyf".',
            );
        });

        it("shorter than its version needs", async function () {
            await expectBroken(
                withLength(ttf, "maxp", 31),
                SfntRule.MaxpVersion,
                'At table "maxp": length is 31, expected at least 32, as the font has table "glyf".',
            );
            await expectBroken(
                withLength(otf, "maxp", 5),
                SfntRule.MaxpVersion,
                'At table "maxp": length is 5, expected at least 6, as the font has table "CFF ".',
            );
        });

        it("with no glyphs", async function () {
            // numGlyphs 0 leaves 3 glyphs of 1296 in fontforge's output.
            for (const font of [ttf, otf]) {
                await expectBroken(
                    withField16(font, "maxp", NUM_GLYPHS_OFFSET_BYTES, 0),
                    SfntRule.NotdefGlyph,
                    'At table "maxp": numGlyphs is 0, expected at least 1.',
                );
            }
        });
    });

    describe("rejects a broken hhea", function () {
        it("shorter than its 36 bytes", async function () {
            await expectBroken(withLength(ttf, "hhea", 35), SfntRule.HheaLength, 'At table "hhea": length is 35, expected at least 36.');
        });

        it("with numberOfHMetrics 0", async function () {
            await expectBroken(
                withField16(ttf, "hhea", NUMBER_OF_H_METRICS_OFFSET_BYTES, 0),
                SfntRule.NumberOfHMetrics,
                `At table "hhea": numberOfHMetrics is 0, expected from 1 to ${TTF_NUM_GLYPHS}, maxp.numGlyphs.`,
            );
        });

        it("with numberOfHMetrics past numGlyphs", async function () {
            for (const numberOfHMetrics of [TTF_NUM_GLYPHS + 1, 65535]) {
                await expectBroken(
                    withField16(ttf, "hhea", NUMBER_OF_H_METRICS_OFFSET_BYTES, numberOfHMetrics),
                    SfntRule.NumberOfHMetrics,
                    `At table "hhea": numberOfHMetrics is ${numberOfHMetrics}, expected from 1 to ${TTF_NUM_GLYPHS}, maxp.numGlyphs.`,
                );
            }
        });

        it("for numGlyphs cut by 100", async function () {
            // fontforge keeps 1196 of the 1296 glyphs.
            await expectBroken(
                withField16(ttf, "maxp", NUM_GLYPHS_OFFSET_BYTES, TTF_NUM_GLYPHS - 100),
                SfntRule.NumberOfHMetrics,
                `At table "hhea": numberOfHMetrics is ${TTF_NUM_GLYPHS}, expected from 1 to ${TTF_NUM_GLYPHS - 100}, maxp.numGlyphs.`,
            );
        });
    });

    describe("rejects a broken hmtx", function () {
        it("declared half its size", async function () {
            await expectBroken(
                withLength(otf, "hmtx", 2590),
                SfntRule.HmtxLength,
                `At table "hmtx": length is 2590, expected at least 5180 for hMetrics[${OTF_NUM_GLYPHS}] and leftSideBearings[0].`,
            );
        });

        it("one byte short of its left side bearings", async function () {
            // One record and 1295 left side bearings take 4 + 2 × 1295 = 2594 bytes.
            const font = withField16(ttf, "hhea", NUMBER_OF_H_METRICS_OFFSET_BYTES, 1);

            await expectBroken(
                withLength(font, "hmtx", 2593),
                SfntRule.HmtxLength,
                'At table "hmtx": length is 2593, expected at least 2594 for hMetrics[1] and leftSideBearings[1295].',
            );
        });

        it("for numGlyphs grown by 100", async function () {
            await expectBroken(
                withField16(ttf, "maxp", NUM_GLYPHS_OFFSET_BYTES, TTF_NUM_GLYPHS + 100),
                SfntRule.HmtxLength,
                `At table "hmtx": length is 5184, expected at least 5384 for hMetrics[${TTF_NUM_GLYPHS}] and leftSideBearings[100].`,
            );
        });
    });

    describe("rejects a broken loca", function () {
        it("shorter than numGlyphs + 1 long offsets", async function () {
            await expectBroken(
                withLength(ttf, "loca", 5187),
                SfntRule.LocaLength,
                'At table "loca": length is 5187, expected at least 5188 for offsets[1297] of 4 bytes.',
            );
        });

        it("shorter than numGlyphs + 1 short offsets", async function () {
            await expectBroken(
                withLength(withShortLoca(ttf), "loca", 2001),
                SfntRule.LocaLength,
                'At table "loca": length is 2001, expected at least 2002 for offsets[1001] of 2 bytes.',
            );
        });

        it("descending at one glyph", async function () {
            // fontforge drops the glyph: 1295 of 1296 are kept.
            const loca = tableOffset(ttf, "loca");
            const descending = readUint32(ttf, loca + 4 * LONG_LOCA_ENTRY_SIZE_BYTES) - 1;

            await expectBroken(
                withUint32(ttf, loca + 5 * LONG_LOCA_ENTRY_SIZE_BYTES, descending),
                SfntRule.LocaAscending,
                `At table "loca": loca[5] in bytes is ${descending}, expected at least ${descending + 1}, loca[4].`,
            );
        });

        it("of long offsets read as short ones", async function () {
            // The long offsets open with 0, 84, 84, 84, 168. Read 2 bytes wide and doubled, the low half
            // of the second gives loca[3] = 168, and the high half of the third loca[4] = 0.
            await expectBroken(
                withField16(ttf, "head", INDEX_TO_LOC_FORMAT_OFFSET_BYTES, 0),
                SfntRule.LocaAscending,
                'At table "loca": loca[4] in bytes is 0, expected at least 168, loca[3].',
            );
        });

        it("whose last offset runs past glyf", async function () {
            await expectBroken(
                withLength(ttf, "glyf", TTF_GLYF_LENGTH_BYTES - 1),
                SfntRule.LocaInGlyf,
                `At table "loca": loca[${TTF_NUM_GLYPHS}] in bytes is ${TTF_GLYF_LENGTH_BYTES}, expected at most ${
                    TTF_GLYF_LENGTH_BYTES - 1
                }, the length of table "glyf".`,
            );
        });

        it("whose last short offset, doubled, runs past glyf", async function () {
            const font = withShortLoca(ttf);
            const lastOffsetBytes = lastShortOffsetBytes(font);

            await expectBroken(
                withLength(font, "glyf", lastOffsetBytes - 1),
                SfntRule.LocaInGlyf,
                `At table "loca": loca[${SHORT_LOCA_NUM_GLYPHS}] in bytes is ${lastOffsetBytes}, expected at most ${
                    lastOffsetBytes - 1
                }, the length of table "glyf".`,
            );
        });
    });

    describe("rejects a broken glyf", function () {
        it("filled with garbage, its length kept", async function () {
            // fontforge keeps every glyph slot and loses every outline: 16 KB of WOFF against 72 KB.
            const garbage = Uint8Array.from(
                { length: TTF_GLYF_LENGTH_BYTES },
                (_, index) => (index * GARBAGE_MULTIPLIER) >>> GARBAGE_SHIFT,
            );

            await expectBroken(
                withBytes(ttf, tableOffset(ttf, "glyf"), garbage),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of endPtsOfContours[158] of glyph 0 is 326, expected at most 84, the length of glyph 0 by loca.',
            );
        });

        it("whose glyph is shorter than its header", async function () {
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_HEADER_SIZE_BYTES - 1)),
                SfntRule.GlyphHeader,
                'At table "glyf": the length of glyph 0 by loca is 9, expected 0 or at least 10.',
            );
        });

        it("whose last glyph is broken, every glyph before it valid", async function () {
            await expectBroken(
                withGlyph(ttf, LAST_GLYPH, glyph0(ttf).subarray(0, GLYPH_HEADER_SIZE_BYTES - 1)),
                SfntRule.GlyphHeader,
                `At table "glyf": the length of glyph ${LAST_GLYPH} by loca is 9, expected 0 or at least 10.`,
            );
            await expectBroken(
                withGlyph(ttf, LAST_GLYPH, glyph0(ttf).subarray(0, GLYPH_0_Y_COORDINATES_END_BYTES - 1)),
                SfntRule.SimpleGlyphInData,
                `At table "glyf": the end of yCoordinates of glyph ${LAST_GLYPH} is 81, expected at most 80, the length of glyph ${LAST_GLYPH} by loca.`,
            );
        });

        it("of a simple glyph without contours and without room for instructionLength", async function () {
            // The 10-byte header alone.
            const withoutContours = withUint16(glyph0(ttf), NUMBER_OF_CONTOURS_OFFSET_BYTES, 0);

            await expectBroken(
                withGlyph(ttf, 0, withoutContours.subarray(0, GLYPH_HEADER_SIZE_BYTES)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of instructionLength of glyph 0 is 12, expected at most 10, the length of glyph 0 by loca.',
            );
        });

        it("whose endPtsOfContours run past the glyph", async function () {
            const endPtsEndBytes = END_PTS_OFFSET_BYTES + GLYPH_0_NUMBER_OF_CONTOURS * END_PT_SIZE_BYTES;

            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, endPtsEndBytes - 1)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of endPtsOfContours[5] of glyph 0 is 20, expected at most 19, the length of glyph 0 by loca.',
            );
            await expectBroken(
                withGlyph(ttf, 0, withUint16(glyph0(ttf), NUMBER_OF_CONTOURS_OFFSET_BYTES, CONTOURS_PAST_GLYPH_0)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of endPtsOfContours[40] of glyph 0 is 90, expected at most 84, the length of glyph 0 by loca.',
            );
        });

        it("whose endPtsOfContours descend", async function () {
            // fontforge drops the outline: "contour ends make no sense".
            await expectBroken(
                withGlyph(ttf, 0, withUint16(glyph0(ttf), END_PTS_OFFSET_BYTES + END_PT_SIZE_BYTES, GLYPH_0_FIRST_END_PT - 1)),
                SfntRule.EndPtsAscending,
                'At table "glyf": endPtsOfContours[1] of glyph 0 is 2, expected more than 3, endPtsOfContours[0].',
            );
        });

        it("whose endPtsOfContours repeat a point, for an empty contour", async function () {
            // fontforge loses nothing here; the rule follows the specification, "increasing numeric order".
            await expectBroken(
                withGlyph(ttf, 0, withUint16(glyph0(ttf), END_PTS_OFFSET_BYTES + END_PT_SIZE_BYTES, GLYPH_0_FIRST_END_PT)),
                SfntRule.EndPtsAscending,
                'At table "glyf": endPtsOfContours[1] of glyph 0 is 3, expected more than 3, endPtsOfContours[0].',
            );
        });

        it("with no room for instructionLength", async function () {
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_FLAGS_OFFSET_BYTES - 1)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of instructionLength of glyph 0 is 22, expected at most 21, the length of glyph 0 by loca.',
            );
        });

        it("whose instructions run past the glyph", async function () {
            // One byte past the glyph, and the most instructionLength can state.
            for (const instructionLength of [GLYPH_0_LENGTH_BYTES - GLYPH_0_FLAGS_OFFSET_BYTES + 1, 0xffff]) {
                await expectBroken(
                    withGlyph(ttf, 0, withUint16(glyph0(ttf), GLYPH_0_INSTRUCTION_LENGTH_OFFSET_BYTES, instructionLength)),
                    SfntRule.SimpleGlyphInData,
                    `At table "glyf": the end of instructions[${instructionLength}] of glyph 0 is ${
                        GLYPH_0_FLAGS_OFFSET_BYTES + instructionLength
                    }, expected at most 84, the length of glyph 0 by loca.`,
                );
            }
        });

        it("whose flags run past the glyph", async function () {
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_FLAGS_OFFSET_BYTES)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of the flag of point 0 of glyph 0 is 23, expected at most 22, the length of glyph 0 by loca.',
            );
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_SECOND_FLAG_OFFSET_BYTES)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of the flag of point 2 of glyph 0 is 25, expected at most 24, the length of glyph 0 by loca.',
            );
        });

        it("whose repeat count runs past the glyph", async function () {
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_REPEAT_COUNT_OFFSET_BYTES)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of the repeat count of the flag of point 0 of glyph 0 is 24, expected at most 23, the length of glyph 0 by loca.',
            );
        });

        it("whose flag repeats run past its points", async function () {
            // fontforge cuts the repeats short, "Flag count is wrong", and loses nothing; the rule follows
            // the specification, one flag per point.
            await expectBroken(
                withGlyph(ttf, 0, withBytes(glyph0(ttf), GLYPH_0_REPEAT_COUNT_OFFSET_BYTES, [GLYPH_0_NUMBER_OF_POINTS])),
                SfntRule.FlagPerPoint,
                'At table "glyf": the flag count with the flag of point 0 and its 16 repeats of glyph 0 is 17, expected at most 16, the number of points.',
            );
        });

        it("whose x coordinates run past the glyph", async function () {
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_X_COORDINATES_END_BYTES - 1)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of xCoordinates of glyph 0 is 60, expected at most 59, the length of glyph 0 by loca.',
            );
        });

        it("whose y coordinates run past the glyph", async function () {
            // fontforge reads the missing byte from the next glyph. Measured on glyph 31, it said "A
            // point in GID 31 is outside the glyph bounding box".
            await expectBroken(
                withGlyph(ttf, 0, glyph0(ttf).subarray(0, GLYPH_0_Y_COORDINATES_END_BYTES - 1)),
                SfntRule.SimpleGlyphInData,
                'At table "glyf": the end of yCoordinates of glyph 0 is 81, expected at most 80, the length of glyph 0 by loca.',
            );
        });
    });

    // fontforge 20230101 loses the outline of a composite glyph cut inside a component, of one whose
    // component points past numGlyphs, and of one on a cycle, the glyph itself included.
    describe("rejects a broken composite glyph", function () {
        it("of its 10-byte header alone, without a component", async function () {
            await expectBroken(
                withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 0, flags: 0 }]).subarray(0, GLYPH_HEADER_SIZE_BYTES)),
                SfntRule.CompositeGlyphInData,
                'At table "glyf": the end of the flags and glyphIndex of component 0 of glyph 1 is 14, expected at most 10, the length of glyph 1 by loca.',
            );
        });

        it("cut inside the flags and glyphIndex of a component past the first", async function () {
            const composite = compositeGlyph([
                { glyphIndex: 0, flags: 0 },
                { glyphIndex: 0, flags: 0 },
            ]);

            await expectBroken(
                withGlyph(ttf, 1, composite.subarray(0, composite.length - BYTE_ARGUMENTS_SIZE_BYTES - 1)),
                SfntRule.CompositeGlyphInData,
                'At table "glyf": the end of the flags and glyphIndex of component 1 of glyph 1 is 20, expected at most 19, the length of glyph 1 by loca.',
            );
        });

        it("whose last component sets MORE_COMPONENTS, with no bytes left", async function () {
            // fontforge says "Bad flags value" and loses nothing; the rule follows the specification.
            await expectBroken(
                withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 0, flags: MORE_COMPONENTS }])),
                SfntRule.CompositeGlyphInData,
                'At table "glyf": the end of the flags and glyphIndex of component 1 of glyph 1 is 20, expected at most 16, the length of glyph 1 by loca.',
            );
        });

        it("cut inside the arguments of a component, of bytes and of words", async function () {
            for (const flags of [0, ARG_1_AND_2_ARE_WORDS]) {
                const composite = compositeGlyph([{ glyphIndex: 0, flags: flags }]);

                await expectBroken(
                    withGlyph(ttf, 1, composite.subarray(0, composite.length - 1)),
                    SfntRule.CompositeGlyphInData,
                    `At table "glyf": the end of the arguments of component 0 of glyph 1 is ${composite.length}, expected at most ${
                        composite.length - 1
                    }, the length of glyph 1 by loca.`,
                );
            }
        });

        it("cut inside the transform of a component, of every scale flag", async function () {
            for (const flags of [WE_HAVE_A_SCALE, WE_HAVE_AN_X_AND_Y_SCALE, WE_HAVE_A_TWO_BY_TWO]) {
                const composite = compositeGlyph([{ glyphIndex: 0, flags: flags }]);

                await expectBroken(
                    withGlyph(ttf, 1, composite.subarray(0, composite.length - 1)),
                    SfntRule.CompositeGlyphInData,
                    `At table "glyf": the end of the transform of component 0 of glyph 1 is ${composite.length}, expected at most ${
                        composite.length - 1
                    }, the length of glyph 1 by loca.`,
                );
            }
        });

        it("with WE_HAVE_INSTRUCTIONS and no room for numInstr", async function () {
            await expectBroken(
                withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 0, flags: WE_HAVE_INSTRUCTIONS }])),
                SfntRule.CompositeGlyphInData,
                'At table "glyf": the end of numInstr of glyph 1 is 18, expected at most 16, the length of glyph 1 by loca.',
            );
        });

        it("with WE_HAVE_INSTRUCTIONS on a component before the last and no room for numInstr", async function () {
            // The prose of the specification reads numInstr "if the flag is set on any component
            // glyph"; its pseudo-code and fontforge read the flag of the last component only. None of
            // the real fonts measured sets it on another component alone.
            const composite = compositeGlyph([
                { glyphIndex: 0, flags: WE_HAVE_INSTRUCTIONS },
                { glyphIndex: 0, flags: 0 },
            ]);

            await expectBroken(
                withGlyph(ttf, 1, composite),
                SfntRule.CompositeGlyphInData,
                'At table "glyf": the end of numInstr of glyph 1 is 24, expected at most 22, the length of glyph 1 by loca.',
            );
        });

        it("whose instructions run past the glyph", async function () {
            const composite = compositeGlyph([{ glyphIndex: 0, flags: WE_HAVE_INSTRUCTIONS }], COMPOSITE_INSTRUCTIONS);

            await expectBroken(
                withGlyph(ttf, 1, composite.subarray(0, composite.length - 1)),
                SfntRule.CompositeGlyphInData,
                `At table "glyf": the end of instructions[${COMPOSITE_INSTRUCTIONS.length}] of glyph 1 is 20, expected at most 19, the length of glyph 1 by loca.`,
            );
        });

        it("whose component points past the glyphs of maxp", async function () {
            // fontforge says "Reference to glyph … out of bounds" and drops the outline.
            for (const glyphIndex of [TTF_NUM_GLYPHS, 0xffff]) {
                await expectBroken(
                    withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: glyphIndex, flags: 0 }])),
                    SfntRule.ComponentGlyphIndex,
                    `At table "glyf": the glyphIndex of component 0 of glyph 1 is ${glyphIndex}, expected less than ${TTF_NUM_GLYPHS}, maxp.numGlyphs.`,
                );
            }
        });

        it("whose component is the glyph itself", async function () {
            await expectBroken(
                withGlyph(ttf, 1, compositeGlyph([{ glyphIndex: 1, flags: 0 }])),
                SfntRule.ComponentCycle,
                'At table "glyf": the chain of components from glyph 1 is 1 -> 1, expected a chain that ends at glyphs without components.',
            );
        });

        it("whose two composite glyphs point at each other", async function () {
            const cycle = withGlyphs(ttf, [
                [1, compositeGlyph([{ glyphIndex: 2, flags: 0 }])],
                [2, compositeGlyph([{ glyphIndex: 1, flags: 0 }])],
            ]);

            await expectBroken(
                cycle,
                SfntRule.ComponentCycle,
                'At table "glyf": the chain of components from glyph 1 is 1 -> 2 -> 1, expected a chain that ends at glyphs without components.',
            );
        });

        it("whose cycle closes past the glyph the chain starts from", async function () {
            // Glyph 1 leads into the cycle of glyphs 2 and 3 and is not on it.
            const cycle = withGlyphs(ttf, [
                [
                    1,
                    compositeGlyph([
                        { glyphIndex: 0, flags: 0 },
                        { glyphIndex: 2, flags: 0 },
                    ]),
                ],
                [2, compositeGlyph([{ glyphIndex: 3, flags: 0 }])],
                [3, compositeGlyph([{ glyphIndex: 2, flags: 0 }])],
            ]);

            await expectBroken(
                cycle,
                SfntRule.ComponentCycle,
                'At table "glyf": the chain of components from glyph 2 is 2 -> 3 -> 2, expected a chain that ends at glyphs without components.',
            );
        });

        it("whose cycle goes through a component past a composite one", async function () {
            // Glyph 1 leads into glyph 2, followed to its end first, and then into glyph 3, which points back at it.
            const cycle = withGlyphs(ttf, [
                [
                    1,
                    compositeGlyph([
                        { glyphIndex: 2, flags: 0 },
                        { glyphIndex: 3, flags: 0 },
                    ]),
                ],
                [2, compositeGlyph([{ glyphIndex: 0, flags: 0 }])],
                [3, compositeGlyph([{ glyphIndex: 1, flags: 0 }])],
            ]);

            await expectBroken(
                cycle,
                SfntRule.ComponentCycle,
                'At table "glyf": the chain of components from glyph 1 is 1 -> 3 -> 1, expected a chain that ends at glyphs without components.',
            );
        });
    });

    describe("rejects a broken cmap", function () {
        it("shorter than its header", async function () {
            await expectBroken(
                withLength(ttf, "cmap", CMAP_HEADER_SIZE_BYTES - 1),
                SfntRule.CmapRecordsInTable,
                'At table "cmap": length is 3, expected at least 4 for the header.',
            );
        });

        it("of version 1", async function () {
            await expectBroken(
                withField16(ttf, "cmap", TABLE_VERSION_OFFSET_BYTES, 1),
                SfntRule.CmapVersion,
                'At table "cmap": version is 1, expected 0.',
            );
        });

        it("with no subtables", async function () {
            // fontforge says "Could not find any valid encoding tables" and drops the encoding.
            await expectBroken(
                withField16(otf, "cmap", CMAP_NUM_TABLES_OFFSET_BYTES, 0),
                SfntRule.CmapSubtables,
                'At table "cmap": numTables is 0, expected at least 1.',
            );
        });

        it("one byte short of its encoding records", async function () {
            await expectBroken(
                withLength(ttf, "cmap", CMAP_RECORDS_END_BYTES - 1),
                SfntRule.CmapRecordsInTable,
                'At table "cmap": length is 27, expected at least 28 for the header and encodingRecords[3].',
            );
        });

        it("whose numTables runs past it", async function () {
            await expectBroken(
                withField16(ttf, "cmap", CMAP_NUM_TABLES_OFFSET_BYTES, CMAP_NUM_TABLES_PAST_END),
                SfntRule.CmapRecordsInTable,
                'At table "cmap": length is 1182, expected at least 1188 for the header and encodingRecords[148].',
            );
        });

        it("whose subtable starts inside its header or encoding records", async function () {
            // fontforge drops the encoding with exit 0 when every record points there (issue #752).
            for (const subtableOffset of [0, CMAP_RECORDS_END_BYTES - 1]) {
                await expectBroken(
                    withSubtableOffset(ttf, 1, subtableOffset),
                    SfntRule.CmapSubtableInTable,
                    `At table "cmap": encodingRecords[1].subtableOffset is ${subtableOffset}, expected at least 28, the end of the header and encodingRecords[3].`,
                );
            }
        });

        it("whose subtable leaves no room for its format", async function () {
            // From the last byte on, fontforge drops the encoding with exit 0 when every record points
            // there (issue #752).
            for (const subtableOffset of [CMAP_LENGTH_BYTES - 1, CMAP_LENGTH_BYTES, 0xffffffff]) {
                await expectBroken(
                    withSubtableOffset(ttf, 1, subtableOffset),
                    SfntRule.CmapSubtableInTable,
                    `At table "cmap": the end of the 2-byte format of the subtable of encodingRecords[1] is ${
                        subtableOffset + SUBTABLE_FORMAT_SIZE_BYTES
                    }, expected at most 1182, the length of table "cmap".`,
                );
            }
        });

        it("cut to its encoding records, its subtables left out", async function () {
            await expectBroken(
                withLength(otf, "cmap", CMAP_RECORDS_END_BYTES),
                SfntRule.CmapSubtableInTable,
                'At table "cmap": the end of the 2-byte format of the subtable of encodingRecords[0] is 30, expected at most 28, the length of table "cmap".',
            );
        });

        it("whose subtable is of a format OpenType does not define", async function () {
            await expectBroken(
                withField16(ttf, "cmap", LAST_SUBTABLE_OFFSET_BYTES, UNDEFINED_SUBTABLE_FORMAT),
                SfntRule.CmapSubtableFormat,
                'At table "cmap": the format of the subtable of encodingRecords[1] is 7, expected one of 0, 2, 4, 6, 8, 10, 12, 13, 14.',
            );
        });

        it("whose subtable leaves no room for the header of its format", async function () {
            for (const [format, { lengthField }] of SUBTABLE_LAYOUTS) {
                const headerSizeBytes = lengthField.offsetBytes + lengthField.sizeBytes;
                const subtableOffset = CMAP_LENGTH_BYTES - headerSizeBytes + 1;

                await expectBroken(
                    withField16(withSubtableOffset(ttf, 1, subtableOffset), "cmap", subtableOffset, format),
                    SfntRule.CmapSubtableInTable,
                    `At table "cmap": the end of the ${headerSizeBytes}-byte fields up to the length of format ${format} of the subtable of encodingRecords[1] is 1183, expected at most 1182, the length of table "cmap".`,
                );
            }
        });

        it("whose subtable is shorter than the part of its format of a set size", async function () {
            // fontforge reads that part past cmap and loses the encoding or makes one up, both with
            // exit 0, or runs past 60 s (issue #757).
            for (const [format, { fixedSizeBytes }] of SUBTABLE_LAYOUTS) {
                await expectBroken(
                    withLastSubtable(ttf, format, fixedSizeBytes, fixedSizeBytes - 1),
                    SfntRule.CmapSubtableMinLength,
                    `At table "cmap": the length of the subtable of encodingRecords[1] is ${
                        fixedSizeBytes - 1
                    }, expected at least ${fixedSizeBytes}, the part of format ${format} of a set size.`,
                );
            }
        });

        it("whose subtable runs past its end", async function () {
            for (const [format, { fixedSizeBytes }] of SUBTABLE_LAYOUTS) {
                await expectBroken(
                    withLastSubtable(ttf, format, fixedSizeBytes, fixedSizeBytes + 1),
                    SfntRule.CmapSubtableLength,
                    `At table "cmap": the length of the subtable of encodingRecords[1] is ${
                        fixedSizeBytes + 1
                    }, expected at most ${fixedSizeBytes}, the rest of table "cmap" from offset 660.`,
                );
            }
        });
    });

    describe("rejects a broken name", function () {
        it("shorter than its header", async function () {
            await expectBroken(
                withLength(ttf, "name", NAME_HEADER_SIZE_BYTES - 1),
                SfntRule.NameRecordsInTable,
                'At table "name": length is 5, expected at least 6 for the header.',
            );
        });

        it("of version 2", async function () {
            await expectBroken(
                withField16(ttf, "name", TABLE_VERSION_OFFSET_BYTES, 2),
                SfntRule.NameVersion,
                'At table "name": version is 2, expected one of 0, 1.',
            );
        });

        it("one byte short of its name records", async function () {
            await expectBroken(
                withLength(otf, "name", NAME_RECORDS_END_BYTES - 1),
                SfntRule.NameRecordsInTable,
                'At table "name": length is 149, expected at least 150 for the header and nameRecord[12].',
            );
        });

        it("with a record count of 60000", async function () {
            // fontforge says "Invalid mac encoding 65535".
            await expectBroken(
                withField16(ttf, "name", NAME_COUNT_OFFSET_BYTES, 60000),
                SfntRule.NameRecordsInTable,
                'At table "name": length is 444, expected at least 720006 for the header and nameRecord[60000].',
            );
        });

        it("whose name records run into the string storage", async function () {
            // fontforge loses nothing here, but the standard lays the storage out after the records.
            await expectBroken(
                withField16(ttf, "name", NAME_COUNT_OFFSET_BYTES, NAME_COUNT + 1),
                SfntRule.NameStorageAfterRecords,
                'At table "name": storageOffset is 150, expected at least 162, the end of nameRecord[13].',
            );
        });

        it("whose last string runs one byte past it", async function () {
            await expectBroken(
                withLength(otf, "name", NAME_STRINGS_END_BYTES - 1),
                SfntRule.NameStringInTable,
                'At table "name": the end of the string of nameRecord[5] is 443, expected at most 442, the length of table "name".',
            );
        });

        it("whose string points past it", async function () {
            // fontforge 20230101 crashes with SIGSEGV on it (issue #752).
            await expectBroken(
                withNameString(ttf, WINDOWS_FULL_NAME_RECORD, STRING_PAST_TABLE.offsetBytes, STRING_PAST_TABLE.lengthBytes),
                SfntRule.NameStringInTable,
                'At table "name": the end of the string of nameRecord[9] is 480, expected at most 444, the length of table "name".',
            );
        });

        it("of version 1 with no room for langTagCount", async function () {
            await expectBroken(
                withLength(withNameVersion1(ttf, 0), "name", NAME_RECORDS_END_BYTES + 1),
                SfntRule.NameRecordsInTable,
                'At table "name": length is 151, expected at least 152 for the header, nameRecord[12] and langTagCount.',
            );
        });

        it("of version 1 whose language-tag records run past it", async function () {
            // The table of version 1 without language tags is 446 bytes long: (446 − 152) / 4 = 73.5.
            await expectBroken(
                withField16(withNameVersion1(ttf, 0), "name", NAME_RECORDS_END_BYTES, LANG_TAGS_PAST_END),
                SfntRule.NameRecordsInTable,
                'At table "name": length is 446, expected at least 448 for the header, nameRecord[12], langTagCount and langTagRecord[74].',
            );
        });

        it("of version 1 whose language-tag records run into the string storage", async function () {
            await expectBroken(
                withField16(withNameVersion1(ttf, 2), "name", NAME_STORAGE_OFFSET_OFFSET_BYTES, NAME_RECORDS_END_BYTES),
                SfntRule.NameStorageAfterRecords,
                'At table "name": storageOffset is 150, expected at least 160, the end of langTagRecord[2].',
            );
        });

        it("of version 1 whose language-tag string points past it", async function () {
            const langTagRecordBytes = NAME_RECORDS_END_BYTES + LANG_TAG_COUNT_SIZE_BYTES;
            const withLengthSet = withField16(
                withNameVersion1(ttf, 1),
                "name",
                langTagRecordBytes + LANG_TAG_RECORD_LENGTH_OFFSET_BYTES,
                STRING_PAST_TABLE.lengthBytes,
            );

            await expectBroken(
                withField16(
                    withLengthSet,
                    "name",
                    langTagRecordBytes + LANG_TAG_RECORD_STRING_OFFSET_OFFSET_BYTES,
                    STRING_PAST_TABLE.offsetBytes,
                ),
                SfntRule.NameStringInTable,
                'At table "name": the end of the string of langTagRecord[0] is 486, expected at most 450, the length of table "name".',
            );
        });
    });

    describe("rejects a broken OS/2", function () {
        it("shorter than its version", async function () {
            await expectBroken(
                withLength(ttf, "OS/2", OS2_VERSION_SIZE_BYTES - 1),
                SfntRule.Os2Length,
                'At table "OS/2": length is 1, expected at least 2 for the version.',
            );
        });

        it("of a version past 5", async function () {
            for (const version of [6, 9]) {
                await expectBroken(
                    withField16(ttf, "OS/2", TABLE_VERSION_OFFSET_BYTES, version),
                    SfntRule.Os2Version,
                    `At table "OS/2": version is ${version}, expected one of 0, 1, 2, 3, 4, 5.`,
                );
            }
        });

        it("declared 10 bytes long", async function () {
            await expectBroken(
                withLength(ttf, "OS/2", 10),
                SfntRule.Os2Length,
                'At table "OS/2": length is 10, expected at least 86 for version 1.',
            );
        });

        it("one byte short of the fields of its version", async function () {
            for (const [version, lengthBytes] of OS2_LENGTHS_BYTES) {
                await expectBroken(
                    withLength(withField16(otf, "OS/2", TABLE_VERSION_OFFSET_BYTES, version), "OS/2", lengthBytes - 1),
                    SfntRule.Os2Length,
                    `At table "OS/2": length is ${lengthBytes - 1}, expected at least ${lengthBytes} for version ${version}.`,
                );
            }
        });
    });

    describe("rejects a broken post", function () {
        it("shorter than its header", async function () {
            await expectBroken(
                withLength(otf, "post", POST_HEADER_SIZE_BYTES - 1),
                SfntRule.PostLength,
                'At table "post": length is 31, expected at least 32 for the header.',
            );
        });

        it("of version 2.0 or 2.5 with no room for numGlyphs", async function () {
            // fontforge renames the glyphs without an encoding with exit 0: 399 of the TrueType fixture
            // lose their names (issue #752).
            for (const version of POST_GLYPH_NAMES.keys()) {
                await expectBroken(
                    withUint32(otf, tableOffset(otf, "post") + TABLE_VERSION_OFFSET_BYTES, version),
                    SfntRule.PostLength,
                    'At table "post": length is 32, expected at least 34 for the header and numGlyphs.',
                );
            }
        });

        it("of version 2.0 or 2.5 one byte short of the entry of its last glyph", async function () {
            for (const [version, glyphNames] of POST_GLYPH_NAMES) {
                const lengthBytes = POST_NUM_GLYPHS_END_BYTES + OTF_NUM_GLYPHS * glyphNames.entrySizeBytes;

                await expectBroken(
                    withLength(withPostGlyphNames(otf, version), "post", lengthBytes - 1),
                    SfntRule.PostLength,
                    `At table "post": length is ${lengthBytes - 1}, expected at least ${lengthBytes} for the header, numGlyphs and ${
                        glyphNames.entries
                    }[${OTF_NUM_GLYPHS}].`,
                );
            }
        });

        it("of version 2.0 or 2.5 naming fewer glyphs than maxp has", async function () {
            // fontforge renames the glyphs past numGlyphs that have no encoding to glyphN with exit
            // 0: 401 of the TrueType fixture with numGlyphs 0 (issue #757).
            for (const version of POST_GLYPH_NAMES.keys()) {
                for (const numGlyphs of [0, OTF_NUM_GLYPHS - 1]) {
                    await expectBroken(
                        withPostGlyphNames(otf, version, numGlyphs),
                        SfntRule.PostNumGlyphs,
                        `At table "post": numGlyphs is ${numGlyphs}, expected at least ${OTF_NUM_GLYPHS}, maxp.numGlyphs.`,
                    );
                }
            }
        });

        it("of version 2.0 whose string its highest glyphNameIndex points at runs one byte past it", async function () {
            // fontforge cuts the glyph name short with exit 0 (issue #757).
            await expectBroken(
                withLength(ttf, "post", TTF_POST_LENGTH_BYTES - 1),
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string ${
                    TTF_POST_STRING_COUNT - 1
                } of stringData is ${TTF_POST_LENGTH_BYTES}, expected at most ${
                    TTF_POST_LENGTH_BYTES - 1
                }, the length of table "post", as glyphNameIndex[${TTF_LAST_GLYPH}] is ${TTF_HIGHEST_GLYPH_NAME_INDEX}.`,
            );
        });

        it("naming the first of the glyphs that share the highest glyphNameIndex", async function () {
            const withNotdefSharingIndex = withGlyphNameIndex(ttf, 0, TTF_HIGHEST_GLYPH_NAME_INDEX);

            await expectBroken(
                withLength(withNotdefSharingIndex, "post", TTF_POST_LENGTH_BYTES - 1),
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string ${
                    TTF_POST_STRING_COUNT - 1
                } of stringData is ${TTF_POST_LENGTH_BYTES}, expected at most ${
                    TTF_POST_LENGTH_BYTES - 1
                }, the length of table "post", as glyphNameIndex[0] is ${TTF_HIGHEST_GLYPH_NAME_INDEX}.`,
            );
        });

        it("of version 2.0 ending with the length byte of the string its highest glyphNameIndex points at", async function () {
            const lengthEndBytes = TTF_LAST_POST_STRING_START_BYTES + 1;

            await expectBroken(
                withLength(ttf, "post", lengthEndBytes),
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string ${
                    TTF_POST_STRING_COUNT - 1
                } of stringData is ${TTF_POST_LENGTH_BYTES}, expected at most ${lengthEndBytes}, the length of table "post", as glyphNameIndex[${TTF_LAST_GLYPH}] is ${TTF_HIGHEST_GLYPH_NAME_INDEX}.`,
            );
        });

        it("of version 2.0 cut right after glyphNameIndex, its strings left out", async function () {
            // fontforge renames 400 glyphs of the TrueType fixture to glyphN with exit 0 (issue #757).
            await expectBroken(
                withLength(ttf, "post", TTF_POST_STRINGS_START_BYTES),
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string 0 of stringData is ${
                    TTF_POST_STRINGS_START_BYTES + 1
                }, expected at most ${TTF_POST_STRINGS_START_BYTES}, the length of table "post", as glyphNameIndex[${TTF_LAST_GLYPH}] is ${TTF_HIGHEST_GLYPH_NAME_INDEX}.`,
            );
        });

        it("of version 2.0 whose entry past the glyphs of maxp points past its strings", async function () {
            const pastStrings = TTF_HIGHEST_GLYPH_NAME_INDEX + 1;
            const withExtraEntry = withExtraGlyphName(ttf, pastStrings);
            const lengthBytes = TTF_POST_LENGTH_BYTES + GLYPH_NAME_INDEX_SIZE_BYTES;

            await expectBroken(
                withExtraEntry,
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string ${TTF_POST_STRING_COUNT} of stringData is ${
                    lengthBytes + 1
                }, expected at most ${lengthBytes}, the length of table "post", as glyphNameIndex[${TTF_NUM_GLYPHS}] is ${pastStrings}.`,
            );
        });

        it("of version 2.0 whose highest glyphNameIndex is the first past the standard names, its string left out", async function () {
            // The first index past the standard names is string 0 of stringData, which the table, cut right after glyphNameIndex, lacks.
            const lengthBytes = POST_NUM_GLYPHS_END_BYTES + OTF_NUM_GLYPHS * GLYPH_NAME_INDEX_SIZE_BYTES;
            const withoutFirstString = withGlyphNameIndex(withPostGlyphNames(otf, 0x00020000), 0, POST_STANDARD_NAME_COUNT);

            await expectBroken(
                withoutFirstString,
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string 0 of stringData is ${
                    lengthBytes + 1
                }, expected at most ${lengthBytes}, the length of table "post", as glyphNameIndex[0] is ${POST_STANDARD_NAME_COUNT}.`,
            );
        });

        it("of version 2.0 whose glyphNameIndex points past its strings", async function () {
            const pastStrings = TTF_HIGHEST_GLYPH_NAME_INDEX + 1;

            await expectBroken(
                withGlyphNameIndex(ttf, TTF_LAST_GLYPH, pastStrings),
                SfntRule.PostNameStringInTable,
                `At table "post": the end of string ${TTF_POST_STRING_COUNT} of stringData is ${
                    TTF_POST_LENGTH_BYTES + 1
                }, expected at most ${TTF_POST_LENGTH_BYTES}, the length of table "post", as glyphNameIndex[${TTF_LAST_GLYPH}] is ${pastStrings}.`,
            );
        });

        it("of a version OpenType does not define", async function () {
            // 4.0 is Apple's, "not supported in OpenType".
            for (const version of [0x00070000, 0x00040000]) {
                await expectBroken(
                    withUint32(ttf, tableOffset(ttf, "post") + TABLE_VERSION_OFFSET_BYTES, version),
                    SfntRule.PostVersion,
                    `At table "post": version is ${hex(version)}, ${POST_VERSIONS_EXPECTED}`,
                );
            }
        });
    });

    it("throws ReadFailed, not an answer, on a file that cannot be read", async function () {
        await expectRejection(() => validator.validate(path.join(workDir, `missing.${Extension.TTF}`)), ReadFailed);
    });

    // The sfnt a WOFF carries is rebuilt in memory: nothing lies at the path validateBytes is given.
    describe("validateBytes", function () {
        it("accepts a TTF and an OTF given as bytes, with no file at the path", function () {
            validator.validateBytes(fontPath, ttf);
            validator.validateBytes(fontPath, otf);
        });

        it("names the given path in its answer on bytes, without reading a file", async function () {
            const error = await expectRejection(async () => validator.validateBytes(fontPath, withoutTable(otf, "cmap")), BrokenSfnt);

            expect(error.payload).to.include({ path: fontPath, rule: SfntRule.RequiredTable });
        });
    });

    async function validate(content: Uint8Array): Promise<void> {
        await fs.writeFile(fontPath, content);
        await validator.validate(fontPath);
    }

    /**
     * Checks, besides the class and the message, that the answer names the rejected file, as every
     * answer of the validator does.
     */
    async function expectAnswer<T extends InvalidSfntFont>(
        content: Uint8Array,
        expected: new (...params: never) => T,
        message: string,
    ): Promise<T> {
        const error = await expectRejection(() => validate(content), expected, message);

        expect(error.payload).to.include({ path: fontPath });

        return error;
    }

    /**
     * `where` is the message past the rule: the part that names the place, the value and the
     * expected one.
     */
    async function expectBroken(content: Uint8Array, rule: SfntRule, where: string): Promise<void> {
        const error = await expectAnswer(content, BrokenSfnt, `Sfnt font breaks a rule: ${rule}. ${where}`);

        expect(error.payload).to.include({ rule: rule });
    }
});

async function expectRejection<T extends Error>(
    call: () => Promise<void>,
    expected: new (...params: never) => T,
    message?: string,
): Promise<T> {
    try {
        await call();
    } catch (error) {
        expect(error).to.be.instanceOf(expected);

        if (message !== undefined) {
            expect((error as T).message).to.equal(message);
        }

        return error as T;
    }

    return expect.fail(`the call did not throw ${expected.name}`);
}

/**
 * The font without the record of `tag`. The records after it move up, and the freed 16 bytes before
 * the tables are zeroed: every table stays where it was, and the offsets stay true.
 */
function withoutTable(font: Uint8Array, tag: string): Uint8Array {
    const recordOffsetBytes = recordOf(font, tag);
    const numTables = readUint16(font, NUM_TABLES_OFFSET_BYTES);
    const directoryEndBytes = HEADER_SIZE_BYTES + numTables * RECORD_SIZE_BYTES;
    const copy = Uint8Array.from(font);

    copy.copyWithin(recordOffsetBytes, recordOffsetBytes + RECORD_SIZE_BYTES, directoryEndBytes);
    copy.fill(0, directoryEndBytes - RECORD_SIZE_BYTES, directoryEndBytes);

    return withUint16(copy, NUM_TABLES_OFFSET_BYTES, numTables - 1);
}

function withTag(font: Uint8Array, tag: string, replacement: string): Uint8Array {
    return withBytes(font, recordOf(font, tag), Buffer.from(replacement, "latin1"));
}

/**
 * The font with its table records sorted by tag, as the directory requires after a renamed tag.
 */
function withRecordsSorted(font: Uint8Array): Uint8Array {
    const numTables = readUint16(font, NUM_TABLES_OFFSET_BYTES);
    const records = Array.from({ length: numTables }, (_, index) =>
        font.slice(HEADER_SIZE_BYTES + index * RECORD_SIZE_BYTES, HEADER_SIZE_BYTES + (index + 1) * RECORD_SIZE_BYTES),
    );

    records.sort((left, right) => Buffer.compare(left.subarray(0, TAG_SIZE_BYTES), right.subarray(0, TAG_SIZE_BYTES)));

    return withBytes(font, HEADER_SIZE_BYTES, Buffer.concat(records));
}

function withSwappedRecords(font: Uint8Array, first: number, second: number): Uint8Array {
    const firstOffsetBytes = HEADER_SIZE_BYTES + first * RECORD_SIZE_BYTES;
    const secondOffsetBytes = HEADER_SIZE_BYTES + second * RECORD_SIZE_BYTES;
    const firstRecord = font.slice(firstOffsetBytes, firstOffsetBytes + RECORD_SIZE_BYTES);
    const secondRecord = font.slice(secondOffsetBytes, secondOffsetBytes + RECORD_SIZE_BYTES);

    return withBytes(withBytes(font, firstOffsetBytes, secondRecord), secondOffsetBytes, firstRecord);
}

/**
 * The offset of the table record of `tag` in the file.
 */
function recordOf(font: Uint8Array, tag: string): number {
    const numTables = readUint16(font, NUM_TABLES_OFFSET_BYTES);

    for (let index = 0; index < numTables; index++) {
        const recordOffsetBytes = HEADER_SIZE_BYTES + index * RECORD_SIZE_BYTES;
        const recordTag = Buffer.from(font.subarray(recordOffsetBytes, recordOffsetBytes + TAG_SIZE_BYTES)).toString("latin1");

        if (recordTag === tag) {
            return recordOffsetBytes;
        }
    }

    return expect.fail(`no table ${tag}`);
}

function tableOffset(font: Uint8Array, tag: string): number {
    return readUint32(font, recordOf(font, tag) + TABLE_OFFSET_OFFSET_BYTES);
}

/**
 * The font with its directory record of `tag` declaring `lengthBytes`: the table stays where it was.
 */
function withLength(font: Uint8Array, tag: string, lengthBytes: number): Uint8Array {
    return withUint32(font, recordOf(font, tag) + LENGTH_OFFSET_BYTES, lengthBytes);
}

function withField16(font: Uint8Array, tag: string, fieldOffsetBytes: number, value: number): Uint8Array {
    return withUint16(font, tableOffset(font, tag) + fieldOffsetBytes, value);
}

/**
 * The TrueType fixture cut to its first `SHORT_LOCA_NUM_GLYPHS` glyphs, with short loca offsets: each
 * long offset halved and written 2 bytes wide over the start of loca. The table keeps its length,
 * longer than the short offsets need, and every glyph its hmtx record.
 */
function withShortLoca(font: Uint8Array): Uint8Array {
    const loca = tableOffset(font, "loca");
    const shortFormat = withField16(font, "head", INDEX_TO_LOC_FORMAT_OFFSET_BYTES, 0);
    const fewerGlyphs = withField16(shortFormat, "maxp", NUM_GLYPHS_OFFSET_BYTES, SHORT_LOCA_NUM_GLYPHS);
    const shortLocaFont = withField16(fewerGlyphs, "hhea", NUMBER_OF_H_METRICS_OFFSET_BYTES, SHORT_LOCA_NUM_GLYPHS);
    const view = new DataView(shortLocaFont.buffer);

    for (let index = 0; index <= SHORT_LOCA_NUM_GLYPHS; index++) {
        const longOffsetBytes = readUint32(font, loca + index * LONG_LOCA_ENTRY_SIZE_BYTES);

        view.setUint16(loca + index * SHORT_LOCA_ENTRY_SIZE_BYTES, longOffsetBytes / SHORT_LOCA_OFFSET_FACTOR);
    }

    return shortLocaFont;
}

/**
 * The end of the last glyph of `withShortLoca`, in bytes: its last short offset doubled.
 */
function lastShortOffsetBytes(font: Uint8Array): number {
    return SHORT_LOCA_OFFSET_FACTOR * readUint16(font, tableOffset(font, "loca") + SHORT_LOCA_NUM_GLYPHS * SHORT_LOCA_ENTRY_SIZE_BYTES);
}

/**
 * The bytes of glyph 0 of the TrueType fixture, by loca.
 */
function glyph0(font: Uint8Array): Uint8Array {
    const glyf = tableOffset(font, "glyf");

    return font.slice(glyf, glyf + GLYPH_0_LENGTH_BYTES);
}

/**
 * The TrueType fixture with glyph `glyphId` replaced by `glyph`.
 */
function withGlyph(font: Uint8Array, glyphId: number, glyph: Uint8Array): Uint8Array {
    return withGlyphs(font, [[glyphId, glyph]]);
}

/**
 * The TrueType fixture with each glyph of `glyphs`, by its id, replaced. glyf and loca are rebuilt,
 * with long offsets, and appended to the end of the file; every other glyph keeps its bytes.
 */
function withGlyphs(font: Uint8Array, glyphs: ReadonlyArray<[number, Uint8Array]>): Uint8Array {
    const replacements = new Map(glyphs);
    const loca = tableOffset(font, "loca");
    const glyf = tableOffset(font, "glyf");
    const rebuiltGlyphs: Uint8Array[] = [];
    const newLoca = new Uint8Array((TTF_NUM_GLYPHS + 1) * LONG_LOCA_ENTRY_SIZE_BYTES);
    const view = new DataView(newLoca.buffer);
    let offsetBytes = 0;

    for (let index = 0; index < TTF_NUM_GLYPHS; index++) {
        const startBytes = readUint32(font, loca + index * LONG_LOCA_ENTRY_SIZE_BYTES);
        const endBytes = readUint32(font, loca + (index + 1) * LONG_LOCA_ENTRY_SIZE_BYTES);
        const glyphBytes = replacements.get(index) ?? font.subarray(glyf + startBytes, glyf + endBytes);

        rebuiltGlyphs.push(glyphBytes);
        view.setUint32(index * LONG_LOCA_ENTRY_SIZE_BYTES, offsetBytes);
        offsetBytes += glyphBytes.length;
    }

    view.setUint32(TTF_NUM_GLYPHS * LONG_LOCA_ENTRY_SIZE_BYTES, offsetBytes);

    return withTableAtEnd(withTableAtEnd(font, "glyf", Uint8Array.from(Buffer.concat(rebuiltGlyphs))), "loca", newLoca);
}

/**
 * A composite glyph of numberOfContours -1 and a zero bounding box, one component per entry of
 * `components`: its flags with ARGS_ARE_XY_VALUES added, and MORE_COMPONENTS on every component but
 * the last, its glyphIndex, then zero arguments and a zero transform of the widths its flags give.
 * With `instructions`, numInstr and the instructions follow the last component.
 */
function compositeGlyph(components: ReadonlyArray<Component>, instructions?: ArrayLike<number>): Uint8Array {
    const header = withUint16(new Uint8Array(GLYPH_HEADER_SIZE_BYTES), NUMBER_OF_CONTOURS_OFFSET_BYTES, -1);
    const parts = [header];

    components.forEach((component, index) => {
        let flags = component.flags | ARGS_ARE_XY_VALUES;

        if (index < components.length - 1) {
            flags |= MORE_COMPONENTS;
        }

        const argumentsSizeBytes = (flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? WORD_ARGUMENTS_SIZE_BYTES : BYTE_ARGUMENTS_SIZE_BYTES;
        const transformSizeBytes =
            TRANSFORM_SIZES_BYTES.get(flags & TRANSFORM_FLAGS) ?? expect.fail(`more than one scale flag in ${flags}`);
        const record = new Uint8Array(COMPONENT_HEADER_SIZE_BYTES + argumentsSizeBytes + transformSizeBytes);
        const view = new DataView(record.buffer);

        view.setUint16(COMPONENT_FLAGS_OFFSET_BYTES, flags);
        view.setUint16(COMPONENT_GLYPH_INDEX_OFFSET_BYTES, component.glyphIndex);
        parts.push(record);
    });

    if (instructions !== undefined) {
        parts.push(withUint16(new Uint8Array(NUM_INSTR_SIZE_BYTES), 0, instructions.length), Uint8Array.from(instructions));
    }

    return Uint8Array.from(Buffer.concat(parts));
}

/**
 * The font with the subtable offset of its cmap encoding record `index` set to `subtableOffset`.
 */
function withSubtableOffset(font: Uint8Array, index: number, subtableOffset: number): Uint8Array {
    return withUint32(font, subtableOffsetField(font, index), subtableOffset);
}

function subtableOffsetOf(font: Uint8Array, index: number): number {
    return readUint32(font, subtableOffsetField(font, index));
}

function subtableOffsetField(font: Uint8Array, index: number): number {
    return tableOffset(font, "cmap") + CMAP_HEADER_SIZE_BYTES + index * ENCODING_RECORD_SIZE_BYTES + SUBTABLE_OFFSET_IN_RECORD_BYTES;
}

/**
 * The font with the header of its last cmap subtable rewritten as of `format`, stating
 * `lengthBytes`. The reserved field of formats 8 to 13 is zeroed; what follows the header is left
 * as it was, as the validator does not read it.
 */
function withSubtableHeader(font: Uint8Array, format: number, lengthBytes: number): Uint8Array {
    const { lengthField } = SUBTABLE_LAYOUTS.get(format) ?? expect.fail(`no cmap subtable format ${format}`);
    const subtableBytes = tableOffset(font, "cmap") + LAST_SUBTABLE_OFFSET_BYTES;
    const header = new Uint8Array(lengthField.offsetBytes + lengthField.sizeBytes);
    const view = new DataView(header.buffer);

    view.setUint16(0, format);

    if (lengthField.sizeBytes === SHORT_SUBTABLE_LENGTH_SIZE_BYTES) {
        view.setUint16(lengthField.offsetBytes, lengthBytes);
    } else {
        view.setUint32(lengthField.offsetBytes, lengthBytes);
    }

    return withBytes(font, subtableBytes, header);
}

/**
 * The font with cmap moved to the end of the file and its last subtable, the one of encoding record
 * 1, rewritten as of `format`, stating `lengthBytes`: the copy of cmap ends `restBytes` after the
 * start of the subtable, cut or lengthened to do so. The bytes past the header are those that
 * followed in the file, which the validator does not read.
 */
function withLastSubtable(font: Uint8Array, format: number, restBytes: number, lengthBytes: number): Uint8Array {
    return withSubtableHeader(withTableMovedToEnd(font, "cmap", LAST_SUBTABLE_OFFSET_BYTES + restBytes), format, lengthBytes);
}

/**
 * The font with the table of `tag` copied to the end of the file, its record pointing at the copy and
 * declaring `lengthBytes`. A copy longer than the table takes the bytes that followed it, which no
 * rule on the table reads; it runs into no other table.
 */
function withTableMovedToEnd(font: Uint8Array, tag: string, lengthBytes: number): Uint8Array {
    const offsetBytes = tableOffset(font, tag);

    return withTableAtEnd(font, tag, font.subarray(offsetBytes, offsetBytes + lengthBytes));
}

/**
 * The font with `table` appended to the end of the file and the record of `tag` pointing at it.
 */
function withTableAtEnd(font: Uint8Array, tag: string, table: Uint8Array): Uint8Array {
    const recordOffsetBytes = recordOf(font, tag);
    const appended = Uint8Array.from(Buffer.concat([font, table]));

    return withUint32(
        withUint32(appended, recordOffsetBytes + TABLE_OFFSET_OFFSET_BYTES, font.length),
        recordOffsetBytes + LENGTH_OFFSET_BYTES,
        table.length,
    );
}

/**
 * The font with its name turned into version 1 and moved to the end of the file: `langTagCount`
 * empty language-tag records follow the name records, and the string storage follows them, its
 * storageOffset moved past them. The table grows by 2 + 4 × `langTagCount` bytes.
 */
function withNameVersion1(font: Uint8Array, langTagCount: number): Uint8Array {
    const name = tableOffset(font, "name");
    const langTags = new Uint8Array(LANG_TAG_COUNT_SIZE_BYTES + langTagCount * LANG_TAG_RECORD_SIZE_BYTES);

    new DataView(langTags.buffer).setUint16(0, langTagCount);

    const table = Uint8Array.from(
        Buffer.concat([
            font.subarray(name, name + NAME_RECORDS_END_BYTES),
            langTags,
            font.subarray(name + NAME_RECORDS_END_BYTES, name + NAME_LENGTH_BYTES),
        ]),
    );
    const view = new DataView(table.buffer);

    view.setUint16(TABLE_VERSION_OFFSET_BYTES, 1);
    view.setUint16(NAME_STORAGE_OFFSET_OFFSET_BYTES, NAME_RECORDS_END_BYTES + langTags.length);

    return withTableAtEnd(font, "name", table);
}

/**
 * The font with the string of its name record `index` placed at `stringOffset` in the storage,
 * `lengthBytes` long.
 */
function withNameString(font: Uint8Array, index: number, stringOffset: number, lengthBytes: number): Uint8Array {
    const recordOffsetBytes = NAME_HEADER_SIZE_BYTES + index * NAME_RECORD_SIZE_BYTES;
    const withStringLength = withField16(font, "name", recordOffsetBytes + NAME_RECORD_LENGTH_OFFSET_BYTES, lengthBytes);

    return withField16(withStringLength, "name", recordOffsetBytes + NAME_RECORD_STRING_OFFSET_OFFSET_BYTES, stringOffset);
}

/**
 * The font with a post of `version`, 2.0 or 2.5, at the end of the file: the header of its post,
 * then `numGlyphs`, the glyph count of the CFF fixture unless given, and a zero entry per glyph, so
 * every glyph of a 2.0 takes a standard name and no string is needed. The table ends with the entry
 * of its last glyph.
 */
function withPostGlyphNames(font: Uint8Array, version: number, numGlyphs: number = OTF_NUM_GLYPHS): Uint8Array {
    const glyphNames = POST_GLYPH_NAMES.get(version) ?? expect.fail(`no glyph names in post ${hex(version)}`);
    const post = tableOffset(font, "post");
    const table = new Uint8Array(POST_NUM_GLYPHS_END_BYTES + numGlyphs * glyphNames.entrySizeBytes);
    const view = new DataView(table.buffer);

    table.set(font.subarray(post, post + POST_HEADER_SIZE_BYTES));
    view.setUint32(TABLE_VERSION_OFFSET_BYTES, version);
    view.setUint16(POST_NUM_GLYPHS_OFFSET_BYTES, numGlyphs);

    return withTableAtEnd(font, "post", table);
}

/**
 * The font with its post 2.0 at the end of the file, naming one glyph more than maxp has: numGlyphs
 * grows by one, and an entry of `glyphNameIndex` follows the last one, before the strings.
 */
function withExtraGlyphName(font: Uint8Array, glyphNameIndex: number): Uint8Array {
    const post = tableOffset(font, "post");
    const numGlyphs = readUint16(font, post + POST_NUM_GLYPHS_OFFSET_BYTES);
    const lengthBytes = readUint32(font, recordOf(font, "post") + LENGTH_OFFSET_BYTES);
    const entriesEndBytes = POST_NUM_GLYPHS_END_BYTES + numGlyphs * GLYPH_NAME_INDEX_SIZE_BYTES;
    const extraEntry = new Uint8Array(GLYPH_NAME_INDEX_SIZE_BYTES);

    new DataView(extraEntry.buffer).setUint16(0, glyphNameIndex);

    const table = Uint8Array.from(
        Buffer.concat([font.subarray(post, post + entriesEndBytes), extraEntry, font.subarray(post + entriesEndBytes, post + lengthBytes)]),
    );

    new DataView(table.buffer).setUint16(POST_NUM_GLYPHS_OFFSET_BYTES, numGlyphs + 1);

    return withTableAtEnd(font, "post", table);
}

function glyphNameIndexOf(font: Uint8Array, glyphIndex: number): number {
    return readUint16(font, tableOffset(font, "post") + POST_NUM_GLYPHS_END_BYTES + glyphIndex * GLYPH_NAME_INDEX_SIZE_BYTES);
}

function withGlyphNameIndex(font: Uint8Array, glyphIndex: number, glyphNameIndex: number): Uint8Array {
    return withField16(font, "post", POST_NUM_GLYPHS_END_BYTES + glyphIndex * GLYPH_NAME_INDEX_SIZE_BYTES, glyphNameIndex);
}

function hex(value: number): string {
    return `0x${value.toString(16).padStart(8, "0")}`;
}

function readUint16(bytes: Uint8Array, offsetBytes: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offsetBytes);
}

function readUint32(bytes: Uint8Array, offsetBytes: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offsetBytes);
}

function withUint16(bytes: Uint8Array, offsetBytes: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint16(offsetBytes, value);

    return copy;
}

function withUint32(bytes: Uint8Array, offsetBytes: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint32(offsetBytes, value);

    return copy;
}

function withBytes(bytes: Uint8Array, offsetBytes: number, replacement: ArrayLike<number>): Uint8Array {
    const copy = Uint8Array.from(bytes);

    copy.set(replacement, offsetBytes);

    return copy;
}
