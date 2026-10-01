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
// checkSumAdjustment in head.
const CHECKSUM_ADJUSTMENT_OFFSET_BYTES = 8;

const TRUETYPE_VERSION = 0x00010000;
const CFF_VERSION = 0x4f54544f;
const COLLECTION_VERSION = 0x74746366;
const VERSIONS_EXPECTED = "expected one of 0x00010000, 0x74727565, 0x4f54544f.";
const OUTLINES_EXPECTED = 'expected "glyf" with "loca", or "CFF ".';

// The TrueType fixture: 13 tables, 158 856 bytes, FFTM the first record and the last table in the
// file. The CFF fixture: 11 tables, 95 936 bytes.
const TTF_SIZE_BYTES = 158856;
const TTF_NUM_TABLES = 13;
const REQUIRED_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "post"];

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
