import { expect } from "chai";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import type { InvalidWoff2Font } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import { BrokenWoff2, NotWoff2 } from "app/font-convertor/validator/woff2/woff2-font-validator.errors";
import { Woff2Rule } from "app/font-convertor/validator/woff2/woff2-font-validator.types";
import { ReadFailed } from "app/shared/fs/file-helper.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const validator = new Woff2FontValidator();

const HEADER_SIZE_BYTES = 48;
const MAX_DECOMPRESSED_SIZE_BYTES = 30 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

// The header fields by their offset (WOFF 2.0, §3.2).
const FLAVOR = 4;
const LENGTH = 8;
const NUM_TABLES = 12;
const RESERVED = 14;
const TOTAL_SFNT_SIZE = 16;
const TOTAL_COMPRESSED_SIZE = 20;
const META_OFFSET = 28;
const META_LENGTH = 32;
const META_ORIG_LENGTH = 36;
const PRIV_OFFSET = 40;
const PRIV_LENGTH = 44;
// The fields of a transformed glyf by their offset in it (§5.1).
const GLYF_OPTION_FLAGS = 2;
const GLYF_NUM_GLYPHS = 4;
const GLYF_INDEX_FORMAT = 6;
const GLYF_N_CONTOUR_STREAM_SIZE = 8;
const GLYF_HEADER_SIZE_BYTES = 36;
// A numGlyphs that is a multiple of 32, so that overlapSimpleBitmap has no bit to spare (§5.1).
const BITMAP_NUM_GLYPHS = 1280;
const BITMAP_WORD_SIZE_BITS = 32;
const BITMAP_WORD_SIZE_BYTES = 4;
const LONG_LOCA_OFFSET_SIZE_BYTES = 4;
// numberOfHMetrics by its offset in hhea (OpenType 1.9.1, hhea).
const HHEA_NUMBER_OF_H_METRICS = 34;

// The "Known Table Tags" of §4.1, by their index in the flags byte.
const KNOWN_TAGS = [
    ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT"],
    ["EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH"],
    ["CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar"],
    ["gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"],
].flat();
const ARBITRARY_TAG_INDEX = 63;

// The fixture: flavor 0x00010000, 13 tables, the directory 41 bytes long, the compressed data
// 44 928 bytes long and padded with 3 null bytes, no metadata and no private block. Its transformed
// glyf: numGlyphs 1296, indexFormat 1, 101 846 bytes.
const FIXTURE_SIZE_BYTES = 45020;
const DIRECTORY_END = 89;
const COMPRESSED_END = 45017;

/**
 * A table directory entry (§4.1) with the bytes the table puts into the decompressed stream.
 */
type Entry = {
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
 * What `build()` lays out into a WOFF2.
 */
type Layout = {
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

describe("Woff2FontValidator.validate", function () {
    let workDir: string;
    // The file every variant is written to: each answer names it in its payload.
    let fontPath: string;
    let fixture: Uint8Array;
    let fixtureLayout: Layout;

    before(async function () {
        fixture = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF2}`));
        fixtureLayout = parse(fixture);
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "woff2-font-validator-"));
        fontPath = path.join(workDir, `font.${Extension.WOFF2}`);
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("the builder lays the fixture out byte for byte", function () {
        // Every variant below is built by it, so each one differs from a valid WOFF2 by its own break alone.
        expect(Buffer.compare(build(fixtureLayout), fixture)).to.equal(0);
    });

    describe("accepts a valid font", function () {
        it("the Roboto fixture", async function () {
            await validate(fixture);
        });

        it("with the tables compressed at Brotli quality 0", async function () {
            await validate(build({ ...fixtureLayout, compressed: brotli(stream(fixtureLayout), 0) }));
        });

        it("with a metadata block", async function () {
            await validate(build({ ...fixtureLayout, metadata: metadata() }));
        });

        it("with a metadata block whose content is garbage, zlib or of another metaOrigLength", async function () {
            // §6 makes the block the one of WOFF 1.0, whose §7 tells a user agent to ignore an invalid one.
            const valid = metadata();

            await validate(build({ ...fixtureLayout, metadata: { stored: Uint8Array.from([1, 2, 3]), origLength: 999 } }));
            await validate(
                build({ ...fixtureLayout, metadata: { stored: zlib.deflateSync(metadataXml()), origLength: valid.origLength } }),
            );
            await validate(build({ ...fixtureLayout, metadata: { stored: valid.stored, origLength: valid.origLength + 1 } }));
        });

        it("with a private block", async function () {
            await validate(build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) }));
        });

        it("with a metadata block of an odd length padded before the private block", async function () {
            // W3C blocks-metadata-padding-003.
            const layout = { ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) };

            expect(layout.metadata.stored.length % 4).to.not.equal(0);
            await validate(build(layout));
        });

        it("with glyf and loca under the null transform", async function () {
            await validate(build(await withPlainGlyfLoca(fixtureLayout)));
        });

        it("with loca at the end of the directory, and with the directory in tag order", async function () {
            // §5.5 lets other tables lie between glyf and loca in a single font.
            const loca = entryOf(fixtureLayout, "loca");
            const locaLast = [...fixtureLayout.entries.filter((entry) => entry !== loca), loca];
            const byTag = fixtureLayout.entries.toSorted((left, right) => (left.tag < right.tag ? -1 : 1));

            await validate(build({ ...fixtureLayout, entries: locaLast }));
            await validate(build({ ...fixtureLayout, entries: byTag }));
        });

        it("with the hmtx transform, flags 1", async function () {
            // Every glyph of the fixture is proportional, and its lsb equal the xMin of the glyphs:
            // flags 1 leaves the advance widths alone.
            await validate(build(withHmtxTransform(fixtureLayout, 0x01)));
        });

        it("with the hmtx transform and the directory in tag order", async function () {
            // Encoders write the directory in tag order, which puts glyf and hhea before hmtx.
            const layout = withHmtxTransform(fixtureLayout, 0x01);
            const byTag = layout.entries.toSorted((left, right) => (left.tag < right.tag ? -1 : 1));

            await validate(build({ ...layout, entries: byTag }));
        });

        it("with a known tag written out after flag 63", async function () {
            // §4.1: the decoder MAY accept it.
            await validate(build(withEntry(fixtureLayout, "cmap", (entry) => ({ ...entry, isTagExplicit: true }))));
        });

        it("whose reserved, totalSfntSize or origLength of glyf is off", async function () {
            // §3.2 and §5.1 forbid a reader to reject on them. W3C header-reserved-001 is invalid, but loads.
            await validate(withUint16(fixture, RESERVED, 1));
            await validate(withUint32(fixture, TOTAL_SFNT_SIZE, 0));
            await validate(withUint32(fixture, TOTAL_SFNT_SIZE, 2 * fixtureLayout.totalSfntSize));
            await validate(build(withEntry(fixtureLayout, "glyf", (entry) => ({ ...entry, origLength: 1 }))));
        });

        it("of every sfnt version the domain accepts, over glyf", async function () {
            // The flavor is not checked against the outlines (W3C header-flavor-001/002).
            for (const version of SFNT_VERSIONS) {
                await validate(withUint32(fixture, FLAVOR, version));
            }
        });

        it("with bit 0 of optionFlags and the overlapSimpleBitmap after the substreams", async function () {
            // 4 × ⌊(1296 + 31) / 32⌋ = 164 bytes.
            const layout = withGlyf(fixtureLayout, (glyf) => {
                const withFlag = withUint16(glyf, GLYF_OPTION_FLAGS, 1);

                return concat(withFlag, new Uint8Array(164));
            });

            await validate(build(layout));
        });

        it("with the overlapSimpleBitmap of a numGlyphs that is a multiple of 32, with no word to spare", async function () {
            const bitmapSizeBytes = (BITMAP_NUM_GLYPHS / BITMAP_WORD_SIZE_BITS) * BITMAP_WORD_SIZE_BYTES;
            const withBitmap = withGlyf(fixtureLayout, (glyf) => {
                const withFlag = withUint16(withUint16(glyf, GLYF_NUM_GLYPHS, BITMAP_NUM_GLYPHS), GLYF_OPTION_FLAGS, 1);

                return concat(withFlag, new Uint8Array(bitmapSizeBytes));
            });
            const locaSizeBytes = (BITMAP_NUM_GLYPHS + 1) * LONG_LOCA_OFFSET_SIZE_BYTES;
            const layout = withEntry(withBitmap, "loca", (entry) => ({ ...entry, origLength: locaSizeBytes }));

            await validate(build(layout));
        });

        it("whose tables decompress to exactly 30 MiB", async function () {
            // The private block brings the file over 30 MiB / 100, so the ratio cap holds too.
            const layout = withZeroTable(fixtureLayout, MAX_DECOMPRESSED_SIZE_BYTES - streamSizeBytes(fixtureLayout));

            await validate(build(withFileSize(layout, Math.ceil(MAX_DECOMPRESSED_SIZE_BYTES / MAX_COMPRESSION_RATIO))));
        });

        it("whose tables decompress to exactly 100 times the file size", async function () {
            // The table of zeros makes the sum a multiple of 100, the private block the file a hundredth of it.
            const roughTableBytes = 10_000_000;
            const zeroTableBytes = roughTableBytes - ((streamSizeBytes(fixtureLayout) + roughTableBytes) % MAX_COMPRESSION_RATIO);
            const layout = withZeroTable(fixtureLayout, zeroTableBytes);

            await validate(build(withFileSize(layout, streamSizeBytes(layout) / MAX_COMPRESSION_RATIO)));
        });
    });

    describe("rejects a file that is not WOFF2", function () {
        it("shorter than the header", async function () {
            await expectAnswer(new Uint8Array(0), NotWoff2, "File is not WOFF2: it is 0 bytes long, shorter than the 48-byte header.");
            await expectAnswer(
                fixture.subarray(0, HEADER_SIZE_BYTES - 1),
                NotWoff2,
                "File is not WOFF2: it is 47 bytes long, shorter than the 48-byte header.",
            );
        });

        it("without the wOF2 signature", async function () {
            // W3C header-signature-001.
            const ttf = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.TTF}`));
            const woff = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.WOFF}`));
            const expected = 'expected 0x774f4632 ("wOF2").';

            await expectAnswer(ttf, NotWoff2, `File is not WOFF2: its signature is 0x00010000, ${expected}`);
            await expectAnswer(woff, NotWoff2, `File is not WOFF2: its signature is 0x774f4646, ${expected}`);
            await expectAnswer(
                withBytes(fixture, 0, Buffer.from("XXXX")),
                NotWoff2,
                `File is not WOFF2: its signature is 0x58585858, ${expected}`,
            );
        });

        it("with the wOF2 signature behind a prefix", async function () {
            // A shifted head would turn the check into a search for the marker anywhere.
            const expected = 'expected 0x774f4632 ("wOF2").';

            await expectAnswer(
                Buffer.concat([Buffer.from("\n"), fixture]),
                NotWoff2,
                `File is not WOFF2: its signature is 0x0a774f46, ${expected}`,
            );
            await expectAnswer(
                Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture]),
                NotWoff2,
                `File is not WOFF2: its signature is 0xefbbbf77, ${expected}`,
            );
        });
    });

    describe("rejects a broken header", function () {
        it("whose flavor is a collection or unknown", async function () {
            const expected = "expected one of 0x00010000, 0x74727565, 0x4f54544f.";

            await expectBroken(
                withUint32(fixture, FLAVOR, 0x74746366),
                Woff2Rule.Flavor,
                `At the header: flavor is 0x74746366, ${expected}`,
            );
            await expectBroken(
                withUint32(fixture, FLAVOR, 0x00020000),
                Woff2Rule.Flavor,
                `At the header: flavor is 0x00020000, ${expected}`,
            );
        });

        it("whose length is not the file size", async function () {
            // W3C header-length-001/002.
            await expectBroken(
                withUint32(fixture, LENGTH, FIXTURE_SIZE_BYTES - 4),
                Woff2Rule.Length,
                "At the header: length is 45016, expected 45020, the file size.",
            );
            await expectBroken(
                withUint32(fixture, LENGTH, FIXTURE_SIZE_BYTES + 4),
                Woff2Rule.Length,
                "At the header: length is 45024, expected 45020, the file size.",
            );
        });

        it("with no tables", async function () {
            // W3C header-numTables-001.
            await expectBroken(
                withUint16(fixture, NUM_TABLES, 0),
                Woff2Rule.TablesPresent,
                "At the header: numTables is 0, expected at least 1.",
            );
        });

        it("with the fields of an absent metadata block not all 0", async function () {
            // W3C blocks-metadata-absent-002: the length is 0, the offset is the end of the file.
            await expectBroken(
                withUint32(fixture, META_OFFSET, FIXTURE_SIZE_BYTES),
                Woff2Rule.BlockAbsence,
                "At the header: metaOffset is 45020, expected 0, as metaLength is 0.",
            );
            await expectBroken(
                withUint32(fixture, META_LENGTH, 1),
                Woff2Rule.BlockAbsence,
                "At the header: metaLength is 1, expected 0, as metaOffset is 0.",
            );
            await expectBroken(
                withUint32(fixture, META_ORIG_LENGTH, 1),
                Woff2Rule.BlockAbsence,
                "At the header: metaOrigLength is 1, expected 0, as metaOffset is 0.",
            );
        });

        it("with the fields of an absent private block not both 0", async function () {
            await expectBroken(
                withUint32(fixture, PRIV_LENGTH, 1),
                Woff2Rule.BlockAbsence,
                "At the header: privLength is 1, expected 0, as privOffset is 0.",
            );
            await expectBroken(
                withUint32(fixture, PRIV_OFFSET, FIXTURE_SIZE_BYTES),
                Woff2Rule.BlockAbsence,
                "At the header: privOffset is 45020, expected 0, as privLength is 0.",
            );
        });
    });

    describe("rejects a broken table directory", function () {
        it("that runs past the end of the file", async function () {
            await expectBroken(
                withUint32(fixture.subarray(0, HEADER_SIZE_BYTES), LENGTH, HEADER_SIZE_BYTES),
                Woff2Rule.DirectoryInFile,
                "At directory entry 1: end is 49, expected at most 48, the file size.",
            );
            // The first entry is flag 63 and the tag FFTM: the file ends inside the tag.
            await expectBroken(
                withUint32(fixture.subarray(0, 51), LENGTH, 51),
                Woff2Rule.DirectoryInFile,
                "At directory entry 1: end is 53, expected at most 51, the file size.",
            );
            // The last entry, post, ends with the 2-byte UIntBase128 of its origLength.
            await expectBroken(
                withUint32(fixture.subarray(0, DIRECTORY_END - 1), LENGTH, DIRECTORY_END - 1),
                Woff2Rule.DirectoryInFile,
                "At directory entry 13: end is 89, expected at most 88, the file size.",
            );
        });

        it("goes on to the blocks in a file that holds the whole directory", async function () {
            await expectBroken(
                withUint32(fixture.subarray(0, DIRECTORY_END), LENGTH, DIRECTORY_END),
                Woff2Rule.BlockInFile,
                "At the compressed data: end is 45017, expected at most 89, the file size.",
            );
        });

        it("with a UIntBase128 that starts with 0x80, runs over 5 bytes or over 4294967295", async function () {
            const withCmapLength = (bytes: Array<number>): Uint8Array =>
                build(withEntry(fixtureLayout, "cmap", (entry) => ({ ...entry, origLengthBytes: Uint8Array.from(bytes) })));
            const at = 'At table "cmap": origLength is';

            // 1220 is 89 44: with a leading 80 it is the same value, a byte longer.
            await expectBroken(withCmapLength([0x80, 0x89, 0x44]), Woff2Rule.UIntBase128, `${at} 80, expected a first byte other than 80.`);
            await expectBroken(
                withCmapLength([0x81, 0x80, 0x80, 0x80, 0x80, 0x00]),
                Woff2Rule.UIntBase128,
                `${at} 81 80 80 80 80, expected at most 5 bytes, the last with bit 7 clear.`,
            );
            await expectBroken(
                withCmapLength([0x90, 0x80, 0x80, 0x80, 0x00]),
                Woff2Rule.UIntBase128,
                `${at} 90 80 80 80 00, expected a value of at most 4294967295.`,
            );
        });

        it("with a transformLength that starts with 0x80", async function () {
            const layout = withEntry(fixtureLayout, "glyf", (entry) => ({
                ...entry,
                transformLengthBytes: concat(Uint8Array.from([0x80]), base128(entry.transformLength ?? 0)),
            }));

            await expectBroken(
                build(layout),
                Woff2Rule.UIntBase128,
                'At table "glyf": transformLength is 80, expected a first byte other than 80.',
            );
        });

        it("reads a UIntBase128 of 4294967295 in 5 bytes, then answers by the cap", async function () {
            const layout = withEntry(fixtureLayout, "cmap", (entry) => ({
                ...entry,
                origLengthBytes: Uint8Array.from([0x8f, 0xff, 0xff, 0xff, 0x7f]),
            }));

            await expectBroken(
                build(layout),
                Woff2Rule.MaxDecompressedSize,
                `At the table directory: sum of the table lengths is ${
                    streamSizeBytes(fixtureLayout) - 1220 + 4294967295
                }, expected at most 31457280.`,
            );
        });

        it("with a transform version not defined for the table", async function () {
            // hmtx of version 2: fontforge converts it with exit 0 and damages the advance widths.
            const withVersion = (tag: string, transformVersion: number): Uint8Array =>
                build(withEntry(fixtureLayout, tag, (entry) => ({ ...entry, transformVersion: transformVersion })));

            await expectBroken(
                withVersion("hmtx", 2),
                Woff2Rule.TransformVersion,
                'At table "hmtx": transform version is 2, expected 0 or 1.',
            );
            await expectBroken(withVersion("cmap", 1), Woff2Rule.TransformVersion, 'At table "cmap": transform version is 1, expected 0.');
            await expectBroken(withVersion("FFTM", 3), Woff2Rule.TransformVersion, 'At table "FFTM": transform version is 3, expected 0.');
            await expectBroken(
                withVersion("glyf", 1),
                Woff2Rule.TransformVersion,
                'At table "glyf": transform version is 1, expected 0 or 3.',
            );
        });

        it("names the table of each known tag index as §4.1 lists it", async function () {
            // Transform version 2 is defined for no table, so the answer names the tag the flags byte decodes to.
            const definedVersions = new Map([
                ["hmtx", "0 or 1"],
                ["glyf", "0 or 3"],
                ["loca", "0 or 3"],
            ]);

            for (const tag of KNOWN_TAGS) {
                const layout = withEntry(fixtureLayout, "cmap", (entry) => ({ ...entry, tag: tag, transformVersion: 2 }));
                const expectedVersions = definedVersions.get(tag) ?? "0";

                await expectBroken(
                    build(layout),
                    Woff2Rule.TransformVersion,
                    `At table ${JSON.stringify(tag)}: transform version is 2, expected ${expectedVersions}.`,
                );
            }
        });

        it("whose transformed tables lack transformLength", async function () {
            // W3C tabledata-transform-length-002. The reader takes the next bytes for it, and the
            // directory comes apart: the flags byte of loca, 0b, becomes the transformLength of
            // glyf, and the first byte of the origLength of loca, a8, the flags of the next entry:
            // tag index 40, bdat, and transform version 2.
            const layout = withEntry(
                withEntry(fixtureLayout, "glyf", (entry) => ({ ...entry, transformLength: undefined })),
                "loca",
                (entry) => ({ ...entry, transformLength: undefined }),
            );

            await expectBroken(build(layout), Woff2Rule.TransformVersion, 'At table "bdat": transform version is 2, expected 0.');
        });

        it("with a tag in two entries", async function () {
            // fontforge converts it with exit 0.
            const twice = withEntry(fixtureLayout, "GDEF", (entry) => ({ ...entry, tag: "FFTM", isTagExplicit: true }));

            await expectBroken(
                build(twice),
                Woff2Rule.SingleEntry,
                'At table "FFTM": directory entry is 2, expected none but entry 1, which has the tag already.',
            );
        });

        it("with glyf or loca alone", async function () {
            await expectBroken(
                build(withoutEntry(fixtureLayout, "loca")),
                Woff2Rule.GlyfLoca,
                'At the table directory: table "loca" is absent, expected present, as table "glyf" is.',
            );
            await expectBroken(
                build(withoutEntry(fixtureLayout, "glyf")),
                Woff2Rule.GlyfLoca,
                'At the table directory: table "glyf" is absent, expected present, as table "loca" is.',
            );
        });

        it("with one of glyf and loca transformed", async function () {
            // W3C tabledata-transform-glyf-loca-001/002.
            await expectBroken(
                build(withEntry(fixtureLayout, "loca", (entry) => ({ ...entry, transformVersion: 3, transformLength: undefined }))),
                Woff2Rule.GlyfLoca,
                'At table "loca": transform version is 3, expected 0, the transform version of table "glyf".',
            );
            await expectBroken(
                build(withEntry(fixtureLayout, "glyf", (entry) => ({ ...entry, transformVersion: 3, transformLength: undefined }))),
                Woff2Rule.GlyfLoca,
                'At table "loca": transform version is 0, expected 3, the transform version of table "glyf".',
            );
        });

        it("with loca before glyf", async function () {
            // W3C directory-table-order-002, which the index of the suite marks valid against its description and §5.5.
            const glyf = entryOf(fixtureLayout, "glyf");
            const loca = entryOf(fixtureLayout, "loca");
            const entries = fixtureLayout.entries.map((entry) => {
                if (entry === glyf) {
                    return loca;
                }

                return entry === loca ? glyf : entry;
            });

            await expectBroken(
                build({ ...fixtureLayout, entries: entries }),
                Woff2Rule.GlyfLoca,
                'At table "loca": directory entry is 6, expected any entry after entry 7, the entry of table "glyf".',
            );
        });

        it("with a transformed loca of a transformLength other than 0", async function () {
            // W3C tabledata-transform-length-001: 4 null bytes for loca in the stream.
            const layout = withEntry(fixtureLayout, "loca", (entry) => ({ ...entry, transformLength: 4, data: new Uint8Array(4) }));

            await expectBroken(build(layout), Woff2Rule.LocaTransform, 'At table "loca": transformLength is 4, expected 0.');
        });

        it("with a transformed hmtx in a font without glyf", async function () {
            const layout = withHmtxTransform(withoutEntry(withoutEntry(fixtureLayout, "glyf"), "loca"), 0x01);

            await expectBroken(
                build(layout),
                Woff2Rule.HmtxTransform,
                'At table "hmtx": transform version is 1, expected 0, as the font has no table "glyf".',
            );
        });
    });

    describe("rejects a transformed hmtx beside a glyf under the null transform, by a rule of ours", function () {
        it("with flags 1 or 2", async function () {
            // The decoder of fontforge takes the glyph count and the xMin for hmtx from a transformed glyf alone.
            const plainGlyf = await withPlainGlyfLoca(fixtureLayout);

            for (const flags of [0x01, 0x02]) {
                await expectBroken(
                    build(withHmtxTransform(plainGlyf, flags)),
                    Woff2Rule.HmtxBesideTransformedGlyf,
                    'At table "hmtx": transform version is 1, expected 0, as table "glyf" is not transformed.',
                );
            }
        });
    });

    describe("rejects a transformed hmtx before glyf or hhea in the table directory, by a rule of ours", function () {
        // The decoder of fontforge rebuilds the tables in directory order: hmtx needs the glyph count
        // and the xMin of the glyphs from glyf and numberOfHMetrics from hhea.
        it("with hmtx before glyf", async function () {
            await expectBroken(
                build(withEntriesFirst(withHmtxTransform(fixtureLayout, 0x01), ["hmtx"])),
                Woff2Rule.HmtxAfterGlyfAndHhea,
                'At table "hmtx": directory entry is 1, expected any entry after entry 7, the entry of table "glyf".',
            );
            await expectBroken(
                build(withEntriesFirst(withHmtxTransform(fixtureLayout, 0x01), ["hhea", "hmtx"])),
                Woff2Rule.HmtxAfterGlyfAndHhea,
                'At table "hmtx": directory entry is 2, expected any entry after entry 8, the entry of table "glyf".',
            );
        });

        it("with hmtx after glyf but before hhea", async function () {
            await expectBroken(
                build(withEntriesFirst(withHmtxTransform(fixtureLayout, 0x01), ["glyf", "loca", "hmtx", "hhea"])),
                Woff2Rule.HmtxAfterGlyfAndHhea,
                'At table "hmtx": directory entry is 3, expected any entry after entry 4, the entry of table "hhea".',
            );
        });
    });

    describe("rejects blocks laid out against the standard", function () {
        it("with the compressed data, the metadata or the private block running past the end of the file", async function () {
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });

            await expectBroken(
                withUint32(fixture, TOTAL_COMPRESSED_SIZE, readUint32(fixture, TOTAL_COMPRESSED_SIZE) + 4),
                Woff2Rule.BlockInFile,
                "At the compressed data: end is 45021, expected at most 45020, the file size.",
            );
            await expectBroken(
                withUint32(withMetadata, META_LENGTH, readUint32(withMetadata, META_LENGTH) + 1),
                Woff2Rule.BlockInFile,
                `At the metadata block: end is ${withMetadata.length + 1}, expected at most ${withMetadata.length}, the file size.`,
            );
            await expectBroken(
                withUint32(withPrivate, PRIV_LENGTH, 6),
                Woff2Rule.BlockInFile,
                "At the private block: end is 45026, expected at most 45025, the file size.",
            );
        });

        it("with the metadata or the private block off a 4-byte boundary", async function () {
            // W3C blocks-metadata-padding-004 and blocks-private-001: the block before is not padded.
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const unpaddedMetadata = splice(withMetadata, COMPRESSED_END, 3, new Uint8Array(0));
            const layout = { ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) };
            const built = build(layout);
            const metadataEnd = readUint32(built, META_OFFSET) + readUint32(built, META_LENGTH);
            const unpaddedPrivate = splice(built, metadataEnd, built.length - 5 - metadataEnd, new Uint8Array(0));

            await expectBroken(
                unpaddedMetadata,
                Woff2Rule.BlockAlignment,
                "At the metadata block: offset is 45017, expected a multiple of 4.",
            );
            await expectBroken(
                unpaddedPrivate,
                Woff2Rule.BlockAlignment,
                `At the private block: offset is ${metadataEnd}, expected a multiple of 4.`,
            );
        });

        it("with a block overlapping the compressed data or another block", async function () {
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withBoth = build({ ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) });

            await expectBroken(
                withUint32(withMetadata, META_OFFSET, COMPRESSED_END - 1),
                Woff2Rule.NoOverlap,
                "At the metadata block: offset is 45016, expected at least 45017, the end of the compressed data.",
            );
            await expectBroken(
                withUint32(withBoth, PRIV_OFFSET, readUint32(withBoth, META_OFFSET) + 4),
                Woff2Rule.NoOverlap,
                `At the private block: offset is ${readUint32(withBoth, META_OFFSET) + 4}, expected at least ${
                    readUint32(withBoth, META_OFFSET) + readUint32(withBoth, META_LENGTH)
                }, the end of the metadata block.`,
            );
        });

        it("with the private block before the metadata", async function () {
            // W3C blocks-ordering-003/004.
            const metadataBlock = metadata();
            const privateData = Uint8Array.from([1, 2, 3, 4]);
            const swapped = withHeader(concat(fixture, privateData, metadataBlock.stored), {
                [META_OFFSET]: FIXTURE_SIZE_BYTES + privateData.length,
                [META_LENGTH]: metadataBlock.stored.length,
                [META_ORIG_LENGTH]: metadataBlock.origLength,
                [PRIV_OFFSET]: FIXTURE_SIZE_BYTES,
                [PRIV_LENGTH]: privateData.length,
            });

            await expectBroken(
                swapped,
                Woff2Rule.NoExtraneousData,
                "At the metadata block: offset is 45024, expected an offset before the private block.",
            );
        });

        it("with extraneous data between the blocks", async function () {
            // W3C blocks-extraneous-data-001, -003, -004 and -005.
            const nulls = new Uint8Array(4);
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const withBoth = build({ ...fixtureLayout, metadata: metadata(), privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const privateOffset = readUint32(withBoth, PRIV_OFFSET);

            await expectBroken(
                splice(fixture, DIRECTORY_END, 0, nulls),
                Woff2Rule.NoExtraneousData,
                "At the file: size is 45024, expected 45020, the end of the compressed data padded to 4 bytes.",
            );
            await expectBroken(
                splice(withMetadata, FIXTURE_SIZE_BYTES, 0, nulls),
                Woff2Rule.NoExtraneousData,
                "At the metadata block: offset is 45024, expected 45020, the end of the compressed data padded to 4 bytes.",
            );
            await expectBroken(
                splice(withPrivate, FIXTURE_SIZE_BYTES, 0, nulls),
                Woff2Rule.NoExtraneousData,
                "At the private block: offset is 45024, expected 45020, the end of the compressed data padded to 4 bytes.",
            );
            await expectBroken(
                splice(withBoth, privateOffset, 0, nulls),
                Woff2Rule.NoExtraneousData,
                `At the private block: offset is ${
                    privateOffset + 4
                }, expected ${privateOffset}, the end of the metadata block padded to 4 bytes.`,
            );
        });

        it("with extraneous data after the last block", async function () {
            // W3C blocks-extraneous-data-002, -006 and -007, blocks-private-002, and
            // blocks-metadata-padding-001: no padding follows the metadata when it is last (§6).
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });
            const withPrivate = build({ ...fixtureLayout, privateData: Uint8Array.from([1, 2, 3, 4, 5]) });
            const metadataEnd = withMetadata.length;
            const extended = (woff2: Uint8Array, extraBytes: number): Uint8Array =>
                withUint32(concat(woff2, new Uint8Array(extraBytes)), LENGTH, woff2.length + extraBytes);

            await expectBroken(
                extended(fixture, 4),
                Woff2Rule.NoExtraneousData,
                "At the file: size is 45024, expected 45020, the end of the compressed data padded to 4 bytes.",
            );
            await expectBroken(
                extended(withMetadata, 4),
                Woff2Rule.NoExtraneousData,
                `At the file: size is ${metadataEnd + 4}, expected ${metadataEnd}, the end of the metadata block.`,
            );
            await expectBroken(
                extended(withMetadata, 4 - (metadataEnd % 4)),
                Woff2Rule.NoExtraneousData,
                `At the file: size is ${Math.ceil(metadataEnd / 4) * 4}, expected ${metadataEnd}, the end of the metadata block.`,
            );
            await expectBroken(
                extended(withPrivate, 4),
                Woff2Rule.NoExtraneousData,
                "At the file: size is 45029, expected 45025, the end of the private block.",
            );
        });

        it("with padding of bytes other than null", async function () {
            // fontforge converts the fixture with non-null padding at the end with exit 0.
            const withMetadata = build({ ...fixtureLayout, metadata: metadata() });

            await expectBroken(
                withBytes(fixture, COMPRESSED_END, [1, 1, 1]),
                Woff2Rule.Padding,
                "At the compressed data: padding is 01 01 01, expected 00 00 00.",
            );
            await expectBroken(
                withBytes(withMetadata, COMPRESSED_END, [0, 0, 1]),
                Woff2Rule.Padding,
                "At the compressed data: padding is 00 00 01, expected 00 00 00.",
            );
        });

        it("whose compressed data ends the file off a 4-byte boundary", async function () {
            // A rule of ours: the fixture cut by its padding crashes fontforge.
            const unpadded = withUint32(fixture.subarray(0, COMPRESSED_END), LENGTH, COMPRESSED_END);

            await expectBroken(unpadded, Woff2Rule.EndPadding, "At the compressed data: padding length is 0, expected 3.");
            await expectBroken(
                withUint32(fixture.subarray(0, COMPRESSED_END + 2), LENGTH, COMPRESSED_END + 2),
                Woff2Rule.EndPadding,
                "At the compressed data: padding length is 2, expected 3.",
            );
        });
    });

    describe("rejects tables that decompress over a cap of ours, before Brotli runs", function () {
        it("over 30 MiB", async function () {
            const broken = build(withUnreadTable(fixtureLayout, MAX_DECOMPRESSED_SIZE_BYTES - streamSizeBytes(fixtureLayout) + 1));

            await expectBroken(
                broken,
                Woff2Rule.MaxDecompressedSize,
                "At the table directory: sum of the table lengths is 31457281, expected at most 31457280.",
            );
        });

        it("over 100 times the file size", async function () {
            // A first build gives the file size: the origLength of the extra table takes 4 bytes either way.
            const sizeBytes = build(withUnreadTable(fixtureLayout, 4_000_000)).length;
            const maxSizeBytes = MAX_COMPRESSION_RATIO * sizeBytes;
            const broken = build(withUnreadTable(fixtureLayout, maxSizeBytes - streamSizeBytes(fixtureLayout) + 1));

            expect(broken.length).to.equal(sizeBytes);
            await expectBroken(
                broken,
                Woff2Rule.MaxCompressionRatio,
                `At the table directory: sum of the table lengths is ${
                    maxSizeBytes + 1
                }, expected at most ${maxSizeBytes}, 100 times the file size.`,
            );
        });
    });

    describe("rejects compressed data that is not the tables", function () {
        it("compressed with zlib instead of Brotli", async function () {
            // W3C tabledata-brotli-001. The error of Node's decoder is the cause.
            const deflated = zlib.deflateSync(stream(fixtureLayout));

            const error = await expectBroken(
                build({ ...fixtureLayout, compressed: deflated }),
                Woff2Rule.Brotli,
                `At the compressed data: decompress error is "Decompression failed", expected a Brotli stream of ${deflated.length} bytes decompressing to 121906.`,
            );

            expect(error.cause).to.be.instanceOf(Error).with.property("message", "Decompression failed");
        });

        it("that decompresses to fewer bytes than the directory gives", async function () {
            // W3C tabledata-decompressed-length-001/003: origLength of the first table and transformLength of glyf grow by 1.
            const expected = "expected a Brotli stream of 44928 bytes decompressing to 121907.";

            await expectBroken(
                build(withEntry(fixtureLayout, "FFTM", (entry) => ({ ...entry, origLength: entry.origLength + 1 }))),
                Woff2Rule.Brotli,
                `At the compressed data: decompressed length is 121906, ${expected}`,
            );
            await expectBroken(
                build(withEntry(fixtureLayout, "glyf", (entry) => ({ ...entry, transformLength: (entry.transformLength ?? 0) + 1 }))),
                Woff2Rule.Brotli,
                `At the compressed data: decompressed length is 121906, ${expected}`,
            );
        });

        it("that decompresses to more bytes than the directory gives", async function () {
            // W3C tabledata-decompressed-length-002/004 and tabledata-extraneous-data-001: 4 bytes
            // more in the stream than hmtx declares.
            const expected = (sizeBytes: number): string =>
                `decompress error is "Cannot create a Buffer larger than ${sizeBytes} bytes", expected a Brotli stream of`;

            await expectBroken(
                build(withEntry(fixtureLayout, "FFTM", (entry) => ({ ...entry, origLength: entry.origLength - 1 }))),
                Woff2Rule.Brotli,
                `At the compressed data: ${expected(121905)} 44928 bytes decompressing to 121905.`,
            );
            await expectBroken(
                build(withEntry(fixtureLayout, "glyf", (entry) => ({ ...entry, transformLength: (entry.transformLength ?? 0) - 1 }))),
                Woff2Rule.Brotli,
                `At the compressed data: ${expected(121905)} 44928 bytes decompressing to 121905.`,
            );

            const extraneous = build(
                withEntry(fixtureLayout, "hmtx", (entry) => ({ ...entry, data: concat(entry.data, new Uint8Array(4)) })),
            );

            await expectBroken(
                extraneous,
                Woff2Rule.Brotli,
                `At the compressed data: ${expected(121906)} ${readUint32(
                    extraneous,
                    TOTAL_COMPRESSED_SIZE,
                )} bytes decompressing to 121906.`,
            );
        });

        it("with bytes after the Brotli stream", async function () {
            const compressed = concat(brotli(stream(fixtureLayout)), Uint8Array.from([1, 2, 3, 4]));

            await expectBroken(
                build({ ...fixtureLayout, compressed: compressed }),
                Woff2Rule.Brotli,
                "At the compressed data: Brotli stream length is 44928, expected a Brotli stream of 44932 bytes decompressing to 121906.",
            );
        });
    });

    describe("rejects transformed tables against their sizes and flags", function () {
        it("with a transformed glyf shorter than its header", async function () {
            const layout = withGlyf(fixtureLayout, (glyf) => glyf.subarray(0, GLYF_HEADER_SIZE_BYTES - 6));

            await expectBroken(
                build(layout),
                Woff2Rule.TransformedGlyf,
                'At table "glyf": transformLength is 30, expected at least 36, the size of the header.',
            );
        });

        it("with substreams that run past the transformed glyf", async function () {
            const layout = withGlyf(fixtureLayout, (glyf) =>
                withUint32(glyf, GLYF_N_CONTOUR_STREAM_SIZE, readUint32(glyf, GLYF_N_CONTOUR_STREAM_SIZE) + 1),
            );

            await expectBroken(
                build(layout),
                Woff2Rule.TransformedGlyf,
                'At table "glyf": end of the substreams is 101847, expected at most 101846, the transformLength.',
            );
        });

        it("with bit 0 of optionFlags and no overlapSimpleBitmap", async function () {
            // fontforge converts it with exit 0: its decoder knows nothing of the bitmap.
            const layout = withGlyf(fixtureLayout, (glyf) => withUint16(glyf, GLYF_OPTION_FLAGS, 1));

            await expectBroken(
                build(layout),
                Woff2Rule.TransformedGlyf,
                'At table "glyf": end of overlapSimpleBitmap is 102010, expected at most 101846, the transformLength, as bit 0 of optionFlags is set.',
            );
        });

        it("with a transformed loca of an origLength other than its glyphs take", async function () {
            await expectBroken(
                build(withEntry(fixtureLayout, "loca", (entry) => ({ ...entry, origLength: 2594 }))),
                Woff2Rule.LocaTransform,
                'At table "loca": origLength is 2594, expected 5188, (numGlyphs 1296 + 1) × 4 for indexFormat 1 of table "glyf".',
            );
            await expectBroken(
                build(withGlyf(fixtureLayout, (glyf) => withUint16(glyf, GLYF_INDEX_FORMAT, 0))),
                Woff2Rule.LocaTransform,
                'At table "loca": origLength is 5188, expected 2594, (numGlyphs 1296 + 1) × 2 for indexFormat 0 of table "glyf".',
            );
        });

        it("with a transformed hmtx whose flags set neither bit 0 nor bit 1, or a reserved bit", async function () {
            // W3C tabledata-hmtx-transform-002/003.
            const expected = "expected bit 0 or bit 1 set, bits 2–7 clear.";

            await expectBroken(
                build(withHmtxTransform(fixtureLayout, 0x00)),
                Woff2Rule.HmtxTransform,
                `At table "hmtx": flags is 00, ${expected}`,
            );
            await expectBroken(
                build(withHmtxTransform(fixtureLayout, 0xff)),
                Woff2Rule.HmtxTransform,
                `At table "hmtx": flags is ff, ${expected}`,
            );
            await expectBroken(
                build(withHmtxTransform(fixtureLayout, 0x04)),
                Woff2Rule.HmtxTransform,
                `At table "hmtx": flags is 04, ${expected}`,
            );
        });

        it("with a transformed hmtx of no flags byte", async function () {
            const layout = withEntry(fixtureLayout, "hmtx", (entry) => ({
                ...entry,
                transformVersion: 1,
                transformLength: 0,
                data: new Uint8Array(0),
            }));

            await expectBroken(
                build(layout),
                Woff2Rule.HmtxTransform,
                'At table "hmtx": transformLength is 0, expected at least 1, for the flags byte.',
            );
        });
    });

    it("throws ReadFailed, not an answer, on a file that cannot be read", async function () {
        await expectRejection(() => validator.validate(path.join(workDir, `missing.${Extension.WOFF2}`)), ReadFailed);
    });

    async function validate(content: Uint8Array): Promise<void> {
        await fs.writeFile(fontPath, content);
        await validator.validate(fontPath);
    }

    /**
     * The answer the validator gives on `content`, checked for its class and message: the payload
     * of every answer names the file.
     */
    async function expectAnswer<T extends InvalidWoff2Font>(
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
    async function expectBroken(content: Uint8Array, rule: Woff2Rule, where: string): Promise<BrokenWoff2> {
        const error = await expectAnswer(content, BrokenWoff2, `WOFF2 breaks a rule: ${rule}. ${where}`);

        expect(error.payload).to.include({ rule: rule });

        return error;
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
 * Reads a WOFF2 into the layout `build()` takes: the header fields it keeps, the entries with the
 * bytes each takes from the decompressed stream. The fixture has no metadata and no private block.
 */
function parse(woff2: Uint8Array): Layout {
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

/**
 * Lays a WOFF2 out as the standard says: the header, the directory, the compressed data padded
 * to 4 bytes (§6, §7, and the rule of ours at the end of the file), then the metadata, padded
 * only when the private block follows it, and the private block.
 */
function build(layout: Layout): Uint8Array {
    const directory = concat(...layout.entries.map(encodeEntry));
    const compressed = layout.compressed ?? brotli(stream(layout));
    const chunks: Array<Uint8Array> = [];
    let offset = HEADER_SIZE_BYTES + directory.length;
    let metaOffset = 0;
    let privOffset = 0;

    const append = (bytes: Uint8Array): void => {
        chunks.push(bytes);
        offset += bytes.length;
    };
    const pad = (): void => append(new Uint8Array((4 - (offset % 4)) % 4));

    append(compressed);
    pad();

    if (layout.metadata !== undefined) {
        metaOffset = offset;
        append(layout.metadata.stored);
    }

    if (layout.privateData !== undefined) {
        pad();
        privOffset = offset;
        append(layout.privateData);
    }

    const head = new DataView(new ArrayBuffer(HEADER_SIZE_BYTES));

    head.setUint32(0, 0x774f4632);
    head.setUint32(FLAVOR, layout.flavor);
    head.setUint32(LENGTH, offset);
    head.setUint16(NUM_TABLES, layout.entries.length);
    head.setUint16(RESERVED, layout.reserved);
    head.setUint32(TOTAL_SFNT_SIZE, layout.totalSfntSize);
    head.setUint32(TOTAL_COMPRESSED_SIZE, compressed.length);
    // majorVersion 1, minorVersion 0: what fontforge wrote into the fixture.
    head.setUint16(24, 1);
    head.setUint32(META_OFFSET, metaOffset);
    head.setUint32(META_LENGTH, layout.metadata?.stored.length ?? 0);
    head.setUint32(META_ORIG_LENGTH, layout.metadata?.origLength ?? 0);
    head.setUint32(PRIV_OFFSET, privOffset);
    head.setUint32(PRIV_LENGTH, layout.privateData?.length ?? 0);

    return concat(new Uint8Array(head.buffer), directory, ...chunks);
}

function encodeEntry(entry: Entry): Uint8Array {
    const tagIndex = entry.isTagExplicit ? ARBITRARY_TAG_INDEX : KNOWN_TAGS.indexOf(entry.tag);

    expect(tagIndex, `no known tag ${entry.tag}`).to.not.equal(-1);

    const parts: Array<Uint8Array> = [Uint8Array.from([(entry.transformVersion << 6) | tagIndex])];

    if (entry.isTagExplicit) {
        parts.push(Buffer.from(entry.tag, "latin1"));
    }

    parts.push(entry.origLengthBytes ?? base128(entry.origLength));

    if (entry.transformLength !== undefined) {
        parts.push(entry.transformLengthBytes ?? base128(entry.transformLength));
    }

    return concat(...parts);
}

/**
 * The shortest UIntBase128 of `value` (§3.1).
 */
function base128(value: number): Uint8Array {
    const bytes = [value % 128];
    let rest = Math.floor(value / 128);

    while (rest > 0) {
        bytes.unshift(0x80 | rest % 128);
        rest = Math.floor(rest / 128);
    }

    return Uint8Array.from(bytes);
}

/**
 * The decompressed stream: the data of the entries in directory order (§5).
 */
function stream(layout: Layout): Uint8Array {
    return concat(...layout.entries.map((entry) => entry.data));
}

/**
 * The sum the directory gives for the stream: transformLength of a transformed table, origLength
 * of any other.
 */
function streamSizeBytes(layout: Layout): number {
    return layout.entries.reduce((sum, entry) => sum + (entry.transformLength ?? entry.origLength), 0);
}

const compressedByStream = new Map<string, Uint8Array>();

/**
 * The stream compressed as the fixture is: quality 11, font mode. That takes a quarter of a second
 * on the fixture, and most variants leave its tables alone, so the result is kept per stream.
 */
function brotli(decompressed: Uint8Array, quality = 11): Uint8Array {
    const key = `${quality}:${crypto.createHash("sha256").update(decompressed).digest("hex")}`;
    let compressed = compressedByStream.get(key);

    if (compressed === undefined) {
        compressed = zlib.brotliCompressSync(decompressed, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT },
        });
        compressedByStream.set(key, compressed);
    }

    return compressed;
}

function entryOf(layout: Layout, tag: string): Entry {
    return layout.entries.find((entry) => entry.tag === tag) ?? expect.fail(`no table ${tag}`);
}

/**
 * The layout with the entry of `tag` as `edit` makes it.
 */
function withEntry(layout: Layout, tag: string, edit: (entry: Entry) => Entry): Layout {
    entryOf(layout, tag);

    return { ...layout, entries: layout.entries.map((entry) => (entry.tag === tag ? edit(entry) : entry)) };
}

function withoutEntry(layout: Layout, tag: string): Layout {
    entryOf(layout, tag);

    return { ...layout, entries: layout.entries.filter((entry) => entry.tag !== tag) };
}

/**
 * The layout with the entries of `tags` moved, in that order, to the start of the directory.
 */
function withEntriesFirst(layout: Layout, tags: Array<string>): Layout {
    const moved = tags.map((tag) => entryOf(layout, tag));

    return { ...layout, entries: [...moved, ...layout.entries.filter((entry) => !moved.includes(entry))] };
}

/**
 * The layout with the transformed glyf as `edit` makes it, transformLength following its length.
 */
function withGlyf(layout: Layout, edit: (glyf: Uint8Array) => Uint8Array): Layout {
    return withEntry(layout, "glyf", (entry) => {
        const data = edit(entry.data);

        return { ...entry, transformLength: data.length, data: data };
    });
}

/**
 * The layout with glyf and loca under the null transform (version 3): the tables of the TTF
 * fixture as they are, without transformLength.
 */
async function withPlainGlyfLoca(layout: Layout): Promise<Layout> {
    const ttf = await fs.readFile(path.join(fixtureDir, `test-font.${Extension.TTF}`));

    return withEntry(withEntry(layout, "glyf", plain(sfntTable(ttf, "glyf"))), "loca", plain(sfntTable(ttf, "loca")));
}

/**
 * An entry turned into the null transform of glyf or loca (version 3) holding `table`.
 */
function plain(table: Uint8Array): (entry: Entry) => Entry {
    return (entry) => ({ ...entry, transformVersion: 3, origLength: table.length, transformLength: undefined, data: table });
}

/**
 * The layout with hmtx transformed (§5.4): the flags byte, the advance widths, then the lsb of
 * the proportional glyphs unless bit 0 is set. Every glyph of the fixture is proportional, so the
 * leftSideBearing array of the monospaced ones is empty whatever bit 1 says.
 */
function withHmtxTransform(layout: Layout, flags: number): Layout {
    const numberOfHMetrics = readUint16(entryOf(layout, "hhea").data, HHEA_NUMBER_OF_H_METRICS);

    return withEntry(layout, "hmtx", (entry) => {
        const metrics = Array.from({ length: numberOfHMetrics }, (_, index) => entry.data.subarray(index * 4, index * 4 + 4));
        const advanceWidths = metrics.map((metric) => metric.subarray(0, 2));
        const lsbs = (flags & 0x01) === 0 ? metrics.map((metric) => metric.subarray(2, 4)) : [];
        const data = concat(Uint8Array.from([flags]), ...advanceWidths, ...lsbs);

        return { ...entry, transformVersion: 1, transformLength: data.length, data: data };
    });
}

/**
 * The layout with one more table, "zzzz", of `lengthBytes` zeros. A stream of tens of MiB takes
 * seconds at quality 11, so it is compressed at quality 0.
 */
function withZeroTable(layout: Layout, lengthBytes: number): Layout {
    const table: Entry = {
        tag: "zzzz",
        transformVersion: 0,
        isTagExplicit: true,
        origLength: lengthBytes,
        transformLength: undefined,
        data: new Uint8Array(lengthBytes),
    };
    const withTable = { ...layout, entries: [...layout.entries, table] };

    return { ...withTable, compressed: brotli(stream(withTable), 0) };
}

/**
 * The layout with one more table, "zzzz", of `origLength` in the directory and nothing in the
 * stream: the caps answer before the stream is read.
 */
function withUnreadTable(layout: Layout, origLength: number): Layout {
    const table: Entry = {
        tag: "zzzz",
        transformVersion: 0,
        isTagExplicit: true,
        origLength: origLength,
        transformLength: undefined,
        data: new Uint8Array(0),
    };

    return { ...layout, entries: [...layout.entries, table] };
}

/**
 * The layout with a private block of zeros that brings the file to `sizeBytes`.
 */
function withFileSize(layout: Layout, sizeBytes: number): Layout {
    const withoutPrivate = build({ ...layout, privateData: undefined });

    return { ...layout, privateData: new Uint8Array(sizeBytes - withoutPrivate.length) };
}

/**
 * A table of an sfnt by its tag.
 */
function sfntTable(sfnt: Uint8Array, tag: string): Uint8Array {
    for (let index = 0; index < readUint16(sfnt, 4); index++) {
        const record = 12 + 16 * index;

        if (Buffer.from(sfnt.subarray(record, record + 4)).toString("latin1") === tag) {
            const offset = readUint32(sfnt, record + 8);

            return sfnt.subarray(offset, offset + readUint32(sfnt, record + 12));
        }
    }

    return expect.fail(`no table ${tag}`);
}

function metadataXml(): Buffer {
    return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<metadata version="1.0"><uniqueid id="test.woff2"/></metadata>\n', "utf8");
}

/**
 * A metadata block of an odd length: XML compressed with Brotli, as §6 asks.
 */
function metadata(): { stored: Uint8Array; origLength: number } {
    const xml = metadataXml();

    return { stored: zlib.brotliCompressSync(xml), origLength: xml.length };
}

/**
 * Removes `removeCount` bytes at `position` and inserts `inserted` there, then moves the offsets
 * of the metadata and the private block that pointed past the removed bytes and sets length to
 * the new size. The compressed data has no offset: it follows the directory.
 */
function splice(woff2: Uint8Array, position: number, removeCount: number, inserted: Uint8Array): Uint8Array {
    const spliced = concat(woff2.subarray(0, position), inserted, woff2.subarray(position + removeCount));
    let moved = spliced;

    for (const field of [META_OFFSET, PRIV_OFFSET]) {
        const offset = readUint32(moved, field);

        if (offset !== 0 && offset >= position + removeCount) {
            moved = withUint32(moved, field, offset + inserted.length - removeCount);
        }
    }

    return withUint32(moved, LENGTH, spliced.length);
}

/**
 * The bytes with the 32-bit header fields set by their offset, and length set to the size.
 */
function withHeader(woff2: Uint8Array, fields: Record<number, number>): Uint8Array {
    let edited = withUint32(woff2, LENGTH, woff2.length);

    for (const [offset, value] of Object.entries(fields)) {
        edited = withUint32(edited, Number(offset), value);
    }

    return edited;
}

function readUint8(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(offset);
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
