import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import type { InvalidWoffFont } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import { BrokenWoff, NotWoff } from "app/font-convertor/validator/woff/woff-font-validator.errors";
import { WoffRule } from "app/font-convertor/validator/woff/woff-font-validator.types";
import { ReadFailed } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const validator = new WoffFontValidator();

const HEADER_SIZE_BYTES = 44;
const ENTRY_SIZE_BYTES = 20;
const SFNT_HEADER_SIZE_BYTES = 12;
const SFNT_TABLE_RECORD_SIZE_BYTES = 16;
const MAX_SFNT_SIZE_BYTES = 32 * 1024 * 1024;

// The header fields by their offset (WOFF 1.0, §4).
const FLAVOR = 4;
const LENGTH = 8;
const NUM_TABLES = 12;
const RESERVED = 14;
const TOTAL_SFNT_SIZE = 16;
const META_OFFSET = 24;
const META_LENGTH = 28;
const META_ORIG_LENGTH = 32;
const PRIV_OFFSET = 36;
const PRIV_LENGTH = 40;
// The fields of a directory entry by their offset in it (§5).
const OFFSET = 4;
const COMP_LENGTH = 8;
const ORIG_LENGTH = 12;
const ORIG_CHECKSUM = 16;

// The fixture: flavor OTTO, 11 tables, 67 316 bytes, no metadata and no private block.
const FIXTURE_SIZE = 67316;

/**
 * A table as a WOFF stores it: compressed when `stored` is shorter than `origLength`.
 */
type StoredTable = {
    tag: string;
    stored: Uint8Array;
    origLength: number;
    origChecksum: number;
};

type Section = "tables" | "metadata" | "private";

/**
 * What `build()` lays out into a WOFF.
 */
type Layout = {
    flavor: number;
    /** In storage order: the directory lists them by tag, the file keeps this order (§6). */
    tables: Array<StoredTable>;
    metadata?: { stored: Uint8Array; origLength: number };
    privateData?: Uint8Array;
    /** The sections after the directory, in the order of §3 when absent. */
    order?: Array<Section>;
};

describe("WoffFontValidator.validate", function () {
    let workDir: string;
    // The file every variant is written to: each answer names it in its payload.
    let fontPath: string;
    let fixture: Uint8Array;
    let fixtureLayout: Layout;

    before(async function () {
        fixture = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF}`));
        fixtureLayout = parse(fixture);
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "woff-font-validator-"));
        fontPath = path.join(workDir, `font.${Extension.WOFF}`);
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("the builder lays the fixture out byte for byte", function () {
        // Every variant below is built by it, so each one differs from a valid WOFF by its own break alone.
        expect(Buffer.compare(build(fixtureLayout), fixture)).to.equal(0);
    });

    describe("accepts a valid font", function () {
        it("the Roboto fixture", async function () {
            await validate(fixture);
        });

        it("with every table stored uncompressed", async function () {
            await validate(
                build({ ...fixtureLayout, tables: fixtureLayout.tables.map((table) => ({ ...table, stored: uncompressed(table) })) }),
            );
        });

        it("with a metadata block", async function () {
            await validate(build({ ...fixtureLayout, metadata: metadata() }));
        });

        it("with a metadata block whose content is neither zlib nor XML", async function () {
            // §7: a user agent MUST ignore an invalid metadata block, so only its bounds are checked.
            await validate(build({ ...fixtureLayout, metadata: { stored: Uint8Array.from([1, 2, 3]), origLength: 999 } }));
        });

        it("with a private block", async function () {
            await validate(build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) }));
        });

        it("with a metadata block of an odd length padded before the private block", async function () {
            const layout = { ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) };

            expect(layout.metadata.stored.length % 4).to.not.equal(0);
            await validate(build(layout));
        });

        it("of every sfnt version the domain accepts", async function () {
            // The flavor is not checked against the outlines: that is a rule of the enclosed sfnt.
            for (const version of SFNT_VERSIONS) {
                await validate(withUint32(fixture, FLAVOR, version));
            }
        });

        it("wrapping the TTF fixture, flavor 0x00010000", async function () {
            const ttf = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.TTF}`));

            await validate(build(wrap(ttf)));
        });

        it("whose head differs from its origChecksum in checkSumAdjustment alone", async function () {
            // The table checksum of head counts checkSumAdjustment (offset 8) as 0.
            await validate(build(withEditedTable(fixtureLayout, "head", (head) => head.fill(0xff, 8, 12))));
        });

        it("of exactly 32 MiB of totalSfntSize", async function () {
            const layout = withLargeTable(fixtureLayout, MAX_SFNT_SIZE_BYTES);

            expect(sfntSize(layout)).to.equal(MAX_SFNT_SIZE_BYTES);
            await validate(build(layout));
        });
    });

    describe("rejects a file that is not WOFF", function () {
        it("shorter than the header", async function () {
            await expectAnswer(new Uint8Array(0), NotWoff, "File is not WOFF: it is 0 bytes long, shorter than the 44-byte header.");
            await expectAnswer(
                fixture.subarray(0, HEADER_SIZE_BYTES - 1),
                NotWoff,
                "File is not WOFF: it is 43 bytes long, shorter than the 44-byte header.",
            );
        });

        it("without the wOFF signature", async function () {
            const ttf = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.TTF}`));
            const woff2 = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF2}`));

            await expectAnswer(ttf, NotWoff, 'File is not WOFF: its signature is 0x00010000, expected 0x774f4646 ("wOFF").');
            await expectAnswer(woff2, NotWoff, 'File is not WOFF: its signature is 0x774f4632, expected 0x774f4646 ("wOFF").');
        });

        it("reads a file of the header alone as WOFF", async function () {
            await expectBroken(
                fixture.subarray(0, HEADER_SIZE_BYTES),
                WoffRule.Length,
                "At the header: length is 67316, expected 44, the file size.",
            );
        });
    });

    describe("rejects a broken header", function () {
        it("whose flavor is a collection or unknown", async function () {
            const expected = "expected one of 0x00010000, 0x74727565, 0x4f54544f.";

            await expectBroken(
                withUint32(fixture, FLAVOR, 0x74746366),
                WoffRule.Flavor,
                `At the header: flavor is 0x74746366, ${expected}`,
            );
            await expectBroken(
                withUint32(fixture, FLAVOR, 0x00020000),
                WoffRule.Flavor,
                `At the header: flavor is 0x00020000, ${expected}`,
            );
        });

        it("whose length is not the file size", async function () {
            // W3C header-length-001/002.
            await expectBroken(
                withUint32(fixture, LENGTH, FIXTURE_SIZE - 4),
                WoffRule.Length,
                "At the header: length is 67312, expected 67316, the file size.",
            );
            await expectBroken(
                withUint32(fixture, LENGTH, FIXTURE_SIZE + 4),
                WoffRule.Length,
                "At the header: length is 67320, expected 67316, the file size.",
            );
        });

        it("with no tables", async function () {
            // W3C header-numTables-001.
            await expectBroken(
                withUint16(fixture, NUM_TABLES, 0),
                WoffRule.TablesPresent,
                "At the header: numTables is 0, expected at least 1.",
            );
        });

        it("whose reserved field is not 0", async function () {
            // W3C header-reserved-001.
            await expectBroken(withUint16(fixture, RESERVED, 1), WoffRule.Reserved, "At the header: reserved is 1, expected 0.");
        });

        it("whose table directory does not fit in the file", async function () {
            const truncated = withUint32(fixture.subarray(0, 263), LENGTH, 263);

            await expectBroken(
                truncated,
                WoffRule.DirectoryInFile,
                "At the file: size is 263, expected at least 264 for 11 directory entries.",
            );
        });

        it("reads a file that holds the whole directory on to the tables", async function () {
            const truncated = withUint32(fixture.subarray(0, 264), LENGTH, 264);

            await expectBroken(truncated, WoffRule.BlockInFile, 'At table "CFF ": end is 64425, expected at most 264, the file size.');
        });

        it("whose totalSfntSize is not the size of the sfnt", async function () {
            // W3C header-totalSfntSize-002/003.
            const expected = "expected 95936.";

            await expectBroken(
                withUint32(fixture, TOTAL_SFNT_SIZE, 95940),
                WoffRule.TotalSfntSize,
                `At the header: totalSfntSize is 95940, ${expected}`,
            );
            await expectBroken(
                withUint32(fixture, TOTAL_SFNT_SIZE, 95932),
                WoffRule.TotalSfntSize,
                `At the header: totalSfntSize is 95932, ${expected}`,
            );
        });

        it("whose totalSfntSize leaves out the padding of a table", async function () {
            // W3C header-totalSfntSize-001: head is 54 bytes long, padded to 56.
            await expectBroken(
                withUint32(fixture, TOTAL_SFNT_SIZE, 95934),
                WoffRule.TotalSfntSize,
                "At the header: totalSfntSize is 95934, expected 95936.",
            );
        });

        it("whose totalSfntSize is over 32 MiB, before inflating any table", async function () {
            // The large table is not zlib: the cap answers before it is inflated.
            const layout = withLargeTable(fixtureLayout, MAX_SFNT_SIZE_BYTES + 4);
            const broken = build({
                ...layout,
                tables: layout.tables.map((table) => (table.tag === "zzzz" ? { ...table, stored: Uint8Array.from([1]) } : table)),
            });

            await expectBroken(broken, WoffRule.MaxSfntSize, "At the header: totalSfntSize is 33554436, expected at most 33554432.");
        });

        it("with the fields of an absent metadata block not all 0", async function () {
            // W3C blocks-metadata-absent-001/002.
            await expectBroken(
                withUint32(fixture, META_LENGTH, 1),
                WoffRule.BlockAbsence,
                "At the header: metaLength is 1, expected 0, as metaOffset is 0.",
            );
            await expectBroken(
                withUint32(fixture, META_OFFSET, FIXTURE_SIZE),
                WoffRule.BlockAbsence,
                "At the header: metaOffset is 67316, expected 0, as metaLength is 0.",
            );
            await expectBroken(
                withUint32(fixture, META_ORIG_LENGTH, 1),
                WoffRule.BlockAbsence,
                "At the header: metaOrigLength is 1, expected 0, as metaOffset is 0.",
            );
        });

        it("with the fields of an absent private block not both 0", async function () {
            // W3C blocks-private-absent-001/002.
            await expectBroken(
                withUint32(fixture, PRIV_LENGTH, 1),
                WoffRule.BlockAbsence,
                "At the header: privLength is 1, expected 0, as privOffset is 0.",
            );
            await expectBroken(
                withUint32(fixture, PRIV_OFFSET, FIXTURE_SIZE),
                WoffRule.BlockAbsence,
                "At the header: privOffset is 67316, expected 0, as privLength is 0.",
            );
        });
    });

    describe("rejects a broken table directory", function () {
        it("whose tags are not in ascending order", async function () {
            // W3C directory-ascending-001: the whole directory in descending order.
            const entries = Array.from({ length: fixtureLayout.tables.length }, (_, index) =>
                fixture.subarray(entryAt(index), entryAt(index + 1)),
            ).reverse();
            const descending = concat(fixture.subarray(0, HEADER_SIZE_BYTES), ...entries, fixture.subarray(entryAt(entries.length)));

            await expectBroken(descending, WoffRule.AscendingTags, 'At table "name": tag is "name", expected a tag after "post".');
        });

        it("with a tag twice", async function () {
            const twice = withBytes(fixture, entryOf(fixture, "GDEF"), Buffer.from("FFTM", "latin1"));

            await expectBroken(twice, WoffRule.AscendingTags, 'At table "FFTM": tag is "FFTM", expected a tag after "FFTM".');
        });

        it("with compLength greater than origLength", async function () {
            // W3C directory-compLength-001.
            const broken = withUint32(fixture, entryOf(fixture, "maxp") + COMP_LENGTH, 7);

            await expectBroken(broken, WoffRule.CompressedLength, 'At table "maxp": compLength is 7, expected at most 6, the origLength.');
        });
    });

    describe("rejects blocks laid out against the standard", function () {
        it("with a table running past the end of the file", async function () {
            // W3C directory-overlaps-001/002.
            const hmtx = entryOf(fixture, "hmtx");

            await expectBroken(
                withUint32(fixture, hmtx + OFFSET, FIXTURE_SIZE + 4),
                WoffRule.BlockInFile,
                'At table "hmtx": end is 70145, expected at most 67316, the file size.',
            );
            await expectBroken(
                withUint32(fixture, hmtx + COMP_LENGTH, 2833),
                WoffRule.BlockInFile,
                'At table "hmtx": end is 67321, expected at most 67316, the file size.',
            );
        });

        it("with a metadata or a private block running past the end of the file", async function () {
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });

            await expectBroken(
                withUint32(withMetadata, META_LENGTH, readUint32(withMetadata, META_LENGTH) + 1),
                WoffRule.BlockInFile,
                "At the metadata block: end is 67408, expected at most 67407, the file size.",
            );
            await expectBroken(
                withUint32(withPrivate, PRIV_LENGTH, 6),
                WoffRule.BlockInFile,
                "At the private block: end is 67322, expected at most 67321, the file size.",
            );
        });

        it("with a table off a 4-byte boundary, named before its broken zlib stream", async function () {
            // W3C directory-4-byte-001. Shifted by a byte, hmtx no longer starts with its zlib stream.
            const hmtx = entryOf(fixture, "hmtx");

            await expectBroken(
                withUint32(fixture, hmtx + OFFSET, 64489),
                WoffRule.TableAlignment,
                'At table "hmtx": offset is 64489, expected a multiple of 4.',
            );
        });

        it("with the private block off a 4-byte boundary", async function () {
            // W3C blocks-private-001: the metadata is not padded.
            const layout = { ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) };
            const built = build(layout);
            const metadataEnd = readUint32(built, META_OFFSET) + readUint32(built, META_LENGTH);
            const unpadded = splice(built, metadataEnd, built.length - 5 - metadataEnd, new Uint8Array(0));

            await expectBroken(unpadded, WoffRule.PrivateAlignment, "At the private block: offset is 67407, expected a multiple of 4.");
        });

        it("with a table overlapping the table directory or another table", async function () {
            // W3C directory-overlaps-005.
            await expectBroken(
                withUint32(fixture, entryOf(fixture, "head") + OFFSET, 260),
                WoffRule.NoOverlap,
                'At table "head": offset is 260, expected at least 264, the end of the table directory.',
            );
            await expectBroken(
                withUint32(fixture, entryOf(fixture, "hmtx") + OFFSET, 64484),
                WoffRule.NoOverlap,
                'At table "hmtx": offset is 64484, expected at least 64486, the end of table "FFTM".',
            );
        });

        it("with a metadata or a private block overlapping a table or each other", async function () {
            // W3C blocks-overlap-001/002/003.
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const withBoth = build({ ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) });

            await expectBroken(
                withUint32(withMetadata, META_OFFSET, FIXTURE_SIZE - 4),
                WoffRule.NoOverlap,
                'At the metadata block: offset is 67312, expected at least 67313, the end of table "hmtx".',
            );
            await expectBroken(
                withUint32(withPrivate, PRIV_OFFSET, FIXTURE_SIZE - 4),
                WoffRule.NoOverlap,
                'At the private block: offset is 67312, expected at least 67313, the end of table "hmtx".',
            );
            await expectBroken(
                withUint32(withBoth, PRIV_OFFSET, readUint32(withBoth, PRIV_OFFSET) - 4),
                WoffRule.NoOverlap,
                "At the private block: offset is 67404, expected at least 67407, the end of the metadata block.",
            );
        });

        it("with extraneous data between or after the blocks", async function () {
            // W3C blocks-extraneous-data-001…007, directory-extraneous-data-001.
            const zeros = new Uint8Array(4);
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const withBoth = build({ ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const privateStart = readUint32(withBoth, PRIV_OFFSET);

            await expectBroken(
                splice(fixture, 264, 0, zeros),
                WoffRule.NoExtraneousData,
                'At table "head": offset is 268, expected 264, the end of the table directory padded to 4 bytes.',
            );
            await expectBroken(
                splice(fixture, 316, 0, zeros),
                WoffRule.NoExtraneousData,
                'At table "hhea": offset is 320, expected 316, the end of table "head" padded to 4 bytes.',
            );
            await expectBroken(
                splice(fixture, FIXTURE_SIZE, 0, zeros),
                WoffRule.NoExtraneousData,
                'At the file: size is 67320, expected 67316, the end of table "hmtx" padded to 4 bytes.',
            );
            await expectBroken(
                splice(withMetadata, FIXTURE_SIZE, 0, zeros),
                WoffRule.NoExtraneousData,
                'At the metadata block: offset is 67320, expected 67316, the end of table "hmtx" padded to 4 bytes.',
            );
            await expectBroken(
                splice(withPrivate, FIXTURE_SIZE, 0, zeros),
                WoffRule.NoExtraneousData,
                'At the private block: offset is 67320, expected 67316, the end of table "hmtx" padded to 4 bytes.',
            );
            await expectBroken(
                splice(withBoth, privateStart, 0, zeros),
                WoffRule.NoExtraneousData,
                "At the private block: offset is 67412, expected 67408, the end of the metadata block padded to 4 bytes.",
            );
            await expectBroken(
                splice(withMetadata, withMetadata.length, 0, zeros),
                WoffRule.NoExtraneousData,
                "At the file: size is 67411, expected 67407, the end of the metadata block.",
            );
            await expectBroken(
                splice(withPrivate, withPrivate.length, 0, zeros),
                WoffRule.NoExtraneousData,
                "At the file: size is 67325, expected 67321, the end of the private block.",
            );
        });

        it("with the metadata padded when it is last", async function () {
            // W3C blocks-metadata-padding-001.
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const padded = splice(withMetadata, withMetadata.length, 0, new Uint8Array(2));

            await expectBroken(
                padded,
                WoffRule.NoExtraneousData,
                "At the file: size is 67409, expected 67407, the end of the metadata block.",
            );
        });

        it("with the blocks out of the order of §3", async function () {
            // W3C blocks-ordering-001…004.
            const metadataFirst = build({ ...fixtureLayout, metadata: metadata(), order: ["metadata", "tables"] });
            const privateFirst = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]), order: ["private", "tables"] });
            const privateBeforeMetadata = build({
                ...fixtureLayout,
                metadata: metadata(),
                privateData: Uint8Array.from([1, 2, 3, 4, 5]),
                order: ["tables", "private", "metadata"],
            });

            await expectBroken(
                metadataFirst,
                WoffRule.NoExtraneousData,
                'At table "head": offset is 356, expected an offset before the metadata block.',
            );
            await expectBroken(
                privateFirst,
                WoffRule.NoExtraneousData,
                'At table "head": offset is 272, expected an offset before the private block.',
            );
            await expectBroken(
                privateBeforeMetadata,
                WoffRule.NoExtraneousData,
                "At the metadata block: offset is 67324, expected an offset before the private block.",
            );
        });

        it("with the last table unpadded", async function () {
            // W3C directory-4-byte-002.
            await expectBroken(
                splice(fixture, 67313, 3, new Uint8Array(0)),
                WoffRule.Padding,
                'At table "hmtx": padding length is 0, expected 3.',
            );
        });

        it("with the metadata right after an unpadded table", async function () {
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });

            await expectBroken(
                splice(withMetadata, 67313, 3, new Uint8Array(0)),
                WoffRule.Padding,
                'At table "hmtx": padding length is 0, expected 3.',
            );
        });

        it("with padding that is not zero", async function () {
            // W3C directory-4-byte-003.
            const withBoth = build({ ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const metadataEnd = readUint32(withBoth, META_OFFSET) + readUint32(withBoth, META_LENGTH);

            await expectBroken(
                withBytes(fixture, 67313, [0, 1, 0]),
                WoffRule.Padding,
                'At table "hmtx": padding is 00 01 00, expected 00 00 00.',
            );
            await expectBroken(
                withBytes(fixture, 313, [0, 0, 1]),
                WoffRule.Padding,
                'At table "head": padding is 00 00 01, expected 00 00 00.',
            );
            await expectBroken(
                withBytes(withBoth, metadataEnd, [1]),
                WoffRule.Padding,
                "At the metadata block: padding is 01, expected 00.",
            );
        });
    });

    describe("rejects a broken table", function () {
        it("that is not zlib", async function () {
            // W3C tabledata-zlib-001.
            const notZlib = withStoredTable(fixtureLayout, "CFF ", (table) => ({
                ...table,
                stored: new Uint8Array(table.stored.length).fill(1),
            }));

            await expectBroken(
                build(notZlib),
                WoffRule.Zlib,
                'At table "CFF ": inflate error is "incorrect header check", expected a zlib stream of 62901 bytes inflating to 88649.',
            );
        });

        it("compressed with raw deflate rather than zlib", async function () {
            const rawDeflate = withStoredTable(fixtureLayout, "CFF ", (table) => ({
                ...table,
                stored: zlib.deflateRawSync(uncompressed(table)),
            }));

            await expectBroken(
                build(rawDeflate),
                WoffRule.Zlib,
                'At table "CFF ": inflate error is "incorrect header check", expected a zlib stream of 62877 bytes inflating to 88649.',
            );
        });

        it("that inflates to more or fewer bytes than origLength", async function () {
            // W3C directory-origLength-001/002.
            const longer = withStoredTable(fixtureLayout, "CFF ", (table) => ({
                ...table,
                stored: zlib.deflateSync(concat(uncompressed(table), new Uint8Array(4))),
            }));
            const shorter = withStoredTable(fixtureLayout, "CFF ", (table) => ({
                ...table,
                stored: zlib.deflateSync(uncompressed(table).subarray(4)),
            }));

            await expectBroken(
                build(longer),
                WoffRule.Zlib,
                'At table "CFF ": inflate error is "Cannot create a Buffer larger than 88649 bytes", expected a zlib stream of 62888 bytes inflating to 88649.',
            );
            await expectBroken(
                build(shorter),
                WoffRule.Zlib,
                'At table "CFF ": inflated length is 88645, expected a zlib stream of 62879 bytes inflating to 88649.',
            );
        });

        it("with bytes after its zlib stream", async function () {
            const trailing = withStoredTable(fixtureLayout, "CFF ", (table) => ({
                ...table,
                stored: concat(table.stored, Uint8Array.from([1, 2, 3])),
            }));

            await expectBroken(
                build(trailing),
                WoffRule.Zlib,
                'At table "CFF ": zlib stream length is 62901, expected a zlib stream of 62904 bytes inflating to 88649.',
            );
        });

        it("whose origChecksum is not its checksum", async function () {
            // W3C directory-origCheckSum-001, on a compressed table and on a stored one.
            const cff = withUint32(fixture, entryOf(fixture, "CFF ") + ORIG_CHECKSUM, 0);
            const maxp = withUint32(fixture, entryOf(fixture, "maxp") + ORIG_CHECKSUM, 0);

            await expectBroken(cff, WoffRule.TableChecksum, 'At table "CFF ": origChecksum is 0x00000000, expected 0x856fe6d0.');
            await expectBroken(maxp, WoffRule.TableChecksum, 'At table "maxp": origChecksum is 0x00000000, expected 0x050f5000.');
        });

        it("whose head differs from its origChecksum past checkSumAdjustment", async function () {
            const changed = withEditedTable(fixtureLayout, "head", (head) => head.fill(0xff, 12, 13));

            await expectBroken(build(changed), WoffRule.TableChecksum, 'At table "head": origChecksum is 0x207982f9, expected 0xc07982f9.');
        });
    });

    it("throws ReadFailed, not an answer, on a file that cannot be read", async function () {
        await expectRejection(() => validator.validate(path.join(workDir, `missing.${Extension.WOFF}`)), ReadFailed);
    });

    async function validate(content: Uint8Array): Promise<void> {
        await fs.writeFile(fontPath, content);
        await validator.validate(fontPath);
    }

    /**
     * Checks, besides the class and the message, that the answer names the rejected file, as every
     * answer of the validator does.
     */
    async function expectAnswer<T extends InvalidWoffFont>(
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
    async function expectBroken(content: Uint8Array, rule: WoffRule, where: string): Promise<void> {
        const error = await expectAnswer(content, BrokenWoff, `WOFF breaks a rule: ${rule}. ${where}`);

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
 * Reads a WOFF into the layout `build()` takes: the tables in storage order, the metadata and the
 * private block as they are stored.
 */
function parse(woff: Uint8Array): Layout {
    const numTables = readUint16(woff, NUM_TABLES);
    const tables = Array.from({ length: numTables }, (_, index) => {
        const entry = entryAt(index);
        const offset = readUint32(woff, entry + OFFSET);

        return {
            offset: offset,
            table: {
                tag: Buffer.from(woff.subarray(entry, entry + 4)).toString("latin1"),
                stored: woff.slice(offset, offset + readUint32(woff, entry + COMP_LENGTH)),
                origLength: readUint32(woff, entry + ORIG_LENGTH),
                origChecksum: readUint32(woff, entry + ORIG_CHECKSUM),
            },
        };
    });

    return {
        flavor: readUint32(woff, FLAVOR),
        tables: tables.sort((left, right) => left.offset - right.offset).map(({ table }) => table),
    };
}

/**
 * Lays a WOFF out as the standard says: the header, the directory in tag order, the sections in
 * `layout.order`. A table is always padded to 4 bytes (§5), any other section only when something
 * follows it (§7, §8).
 */
function build(layout: Layout): Uint8Array {
    const order = (layout.order ?? ["tables", "metadata", "private"]).filter(
        (section) => section === "tables" || (section === "metadata" ? layout.metadata : layout.privateData) !== undefined,
    );
    const chunks: Array<Uint8Array> = [];
    const tableOffsets = new Map<StoredTable, number>();
    let offset = HEADER_SIZE_BYTES + ENTRY_SIZE_BYTES * layout.tables.length;
    let metaOffset = 0;
    let privOffset = 0;

    const append = (bytes: Uint8Array, isPadded: boolean): void => {
        const padding = isPadded ? (4 - (bytes.length % 4)) % 4 : 0;

        chunks.push(bytes, new Uint8Array(padding));
        offset += bytes.length + padding;
    };

    order.forEach((section, index) => {
        const isLast = index === order.length - 1;

        if (section === "tables") {
            for (const table of layout.tables) {
                tableOffsets.set(table, offset);
                append(table.stored, true);
            }
        } else if (section === "metadata" && layout.metadata !== undefined) {
            metaOffset = offset;
            append(layout.metadata.stored, !isLast);
        } else if (section === "private" && layout.privateData !== undefined) {
            privOffset = offset;
            append(layout.privateData, !isLast);
        }
    });

    const head = new DataView(new ArrayBuffer(HEADER_SIZE_BYTES));

    head.setUint32(0, 0x774f4646);
    head.setUint32(FLAVOR, layout.flavor);
    head.setUint32(LENGTH, offset);
    head.setUint16(NUM_TABLES, layout.tables.length);
    head.setUint32(TOTAL_SFNT_SIZE, sfntSize(layout));
    // majorVersion 1, minorVersion 0: what fontforge wrote into the fixture.
    head.setUint16(20, 1);
    head.setUint32(META_OFFSET, metaOffset);
    head.setUint32(META_LENGTH, layout.metadata?.stored.length ?? 0);
    head.setUint32(META_ORIG_LENGTH, layout.metadata?.origLength ?? 0);
    head.setUint32(PRIV_OFFSET, privOffset);
    head.setUint32(PRIV_LENGTH, layout.privateData?.length ?? 0);

    const byTag = layout.tables.toSorted((left, right) => (left.tag < right.tag ? -1 : 1));
    const directory = byTag.map((table) => {
        const entry = new DataView(new ArrayBuffer(ENTRY_SIZE_BYTES));

        Buffer.from(table.tag, "latin1").forEach((byte, index) => entry.setUint8(index, byte));
        entry.setUint32(OFFSET, tableOffsets.get(table) ?? 0);
        entry.setUint32(COMP_LENGTH, table.stored.length);
        entry.setUint32(ORIG_LENGTH, table.origLength);
        entry.setUint32(ORIG_CHECKSUM, table.origChecksum);

        return new Uint8Array(entry.buffer);
    });

    return concat(new Uint8Array(head.buffer), ...directory, ...chunks);
}

function sfntSize(layout: Layout): number {
    const tablesSize = layout.tables.reduce((size, table) => size + Math.ceil(table.origLength / 4) * 4, 0);

    return SFNT_HEADER_SIZE_BYTES + SFNT_TABLE_RECORD_SIZE_BYTES * layout.tables.length + tablesSize;
}

/**
 * The sfnt of a TTF or an OTF as a WOFF layout: each table compressed with zlib where that makes it
 * shorter (§5), in the order of the sfnt.
 */
function wrap(sfnt: Uint8Array): Layout {
    const numTables = readUint16(sfnt, 4);
    const records = Array.from({ length: numTables }, (_, index) => {
        const record = SFNT_HEADER_SIZE_BYTES + SFNT_TABLE_RECORD_SIZE_BYTES * index;

        return {
            tag: Buffer.from(sfnt.subarray(record, record + 4)).toString("latin1"),
            origChecksum: readUint32(sfnt, record + 4),
            offset: readUint32(sfnt, record + 8),
            length: readUint32(sfnt, record + 12),
        };
    });
    const tables = records
        .sort((left, right) => left.offset - right.offset)
        .map((record) => compressed(record.tag, sfnt.slice(record.offset, record.offset + record.length), record.origChecksum));

    return { flavor: readUint32(sfnt, 0), tables: tables };
}

function compressed(tag: string, table: Uint8Array, origChecksum: number): StoredTable {
    const deflated = zlib.deflateSync(table);

    return { tag: tag, stored: deflated.length < table.length ? deflated : table, origLength: table.length, origChecksum: origChecksum };
}

function uncompressed(table: StoredTable): Uint8Array {
    return table.stored.length < table.origLength ? zlib.inflateSync(table.stored) : table.stored;
}

/**
 * The layout with the uncompressed bytes of one table changed by `edit`: the table is stored
 * compressed again, with its origChecksum kept.
 */
function withEditedTable(layout: Layout, tag: string, edit: (table: Uint8Array) => void): Layout {
    return withStoredTable(layout, tag, (table) => {
        const bytes = Uint8Array.from(uncompressed(table));

        edit(bytes);

        return compressed(tag, bytes, table.origChecksum);
    });
}

/**
 * The layout with one table as `replace` stores it.
 */
function withStoredTable(layout: Layout, tag: string, replace: (table: StoredTable) => StoredTable): Layout {
    return { ...layout, tables: layout.tables.map((table) => (table.tag === tag ? replace(table) : table)) };
}

/**
 * The layout with one more table of zeros, "zzzz", that makes totalSfntSize exactly `sfntSize`.
 */
function withLargeTable(layout: Layout, targetSfntSize: number): Layout {
    const origLength = targetSfntSize - sfntSize(layout) - SFNT_TABLE_RECORD_SIZE_BYTES;

    return { ...layout, tables: [...layout.tables, compressed("zzzz", new Uint8Array(origLength), 0)] };
}

/**
 * A metadata block of an odd length: XML compressed with zlib, as §7 asks.
 */
function metadata(): { stored: Uint8Array; origLength: number } {
    const xml = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>\n<metadata version="1.0"><uniqueid id="test.woff"/></metadata>\n',
        "utf8",
    );

    return { stored: zlib.deflateSync(xml), origLength: xml.length };
}

/**
 * Removes `removeCount` bytes at `position` and inserts `inserted` there, then moves every offset
 * that pointed past the removed bytes and sets length to the new size.
 */
function splice(woff: Uint8Array, position: number, removeCount: number, inserted: Uint8Array): Uint8Array {
    const result = concat(woff.subarray(0, position), inserted, woff.subarray(position + removeCount));
    const delta = inserted.length - removeCount;
    const offsetFields = [
        META_OFFSET,
        PRIV_OFFSET,
        ...Array.from({ length: readUint16(woff, NUM_TABLES) }, (_, index) => entryAt(index) + OFFSET),
    ];
    let moved = result;

    for (const field of offsetFields) {
        const offset = readUint32(moved, field);

        if (offset !== 0 && offset >= position + removeCount) {
            moved = withUint32(moved, field, offset + delta);
        }
    }

    return withUint32(moved, LENGTH, result.length);
}

function entryAt(index: number): number {
    return HEADER_SIZE_BYTES + ENTRY_SIZE_BYTES * index;
}

/**
 * The offset of the directory entry of `tag`.
 */
function entryOf(woff: Uint8Array, tag: string): number {
    const numTables = readUint16(woff, NUM_TABLES);

    for (let index = 0; index < numTables; index++) {
        if (Buffer.from(woff.subarray(entryAt(index), entryAt(index) + 4)).toString("latin1") === tag) {
            return entryAt(index);
        }
    }

    return expect.fail(`no table ${tag}`);
}

function readUint16(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function withUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint16(offset, value);

    return copy;
}

function withUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const copy = Uint8Array.from(bytes);

    new DataView(copy.buffer).setUint32(offset, value);

    return copy;
}

function withBytes(bytes: Uint8Array, offset: number, replacement: ArrayLike<number>): Uint8Array {
    const copy = Uint8Array.from(bytes);

    copy.set(replacement, offset);

    return copy;
}

function concat(...parts: Array<Uint8Array>): Uint8Array {
    return Buffer.concat(parts);
}
