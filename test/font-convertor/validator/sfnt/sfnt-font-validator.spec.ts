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
// its last offset is the length of glyf. Every table a length rule covers is exactly as long as its
// fields need: head 54, hhea 36, maxp 32 and 6, the hmtx and loca of the TrueType fixture. Accepting
// the fixtures holds each length rule at its boundary.
const TTF_NUM_GLYPHS = 1296;
const OTF_NUM_GLYPHS = 1295;
const TTF_GLYF_LENGTH_BYTES = 133424;
// Its glyphs up to this one end below 131 070, the largest offset the short loca format holds.
const SHORT_LOCA_NUM_GLYPHS = 1000;
const REQUIRED_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "post"];

describe("SfntFontValidator.validate", function () {
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

    it("throws ReadFailed, not an answer, on a file that cannot be read", async function () {
        await expectRejection(() => validator.validate(path.join(workDir, `missing.${Extension.TTF}`)), ReadFailed);
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
