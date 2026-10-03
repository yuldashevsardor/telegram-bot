import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { InvalidEotPayload } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder.errors";
import type { InvalidEotFont } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import { BrokenEot, NotEot } from "app/font-convertor/validator/eot/eot-font-validator.errors";
import { EotRule } from "app/font-convertor/validator/eot/eot-font-validator.types";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import type { InvalidSfntFont } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { ReadFailed } from "app/shared/fs/file-helper.errors";
import { fontDataOf, overwritten, xor } from "test/font-convertor/eot-payload-decoder.helper";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const sfntFontValidator = new SfntFontValidator();
const validator = new EotFontValidator(sfntFontValidator, new EotPayloadDecoder());

// The fields of the fixed part by their offset (EOT, §3). The spec keeps its own copies rather
// than the constants of EotHeader, so that a wrong constant in the class fails its spec.
const EOT_SIZE = 0;
const FONT_DATA_SIZE = 4;
const VERSION = 8;
const FLAGS = 12;
const FS_TYPE = 32;
const MAGIC_NUMBER = 34;
const RESERVED_1 = 64;
const RESERVED_4 = 76;
// The fixed part up to Padding1, which build() writes as the padding of the first name.
const FIXED_PART_BEFORE_PADDING_1_BYTES = 80;
// A block of the variable part opens with Padding (u16) and its size (u16).
const BLOCK_PREFIX_BYTES = 4;

const VERSION_1_0 = 0x00010000;
const VERSION_2_2 = 0x00020002;
const ROOT_STRING_CHECKSUM_KEY = 0x50475342;
const TTEMBED_SUBSET = 0x00000001;
const TTEMBED_TTCOMPRESSED = 0x00000004;
const TTEMBED_XORENCRYPTDATA = 0x10000000;
// §4.2 lists no flag at this bit.
const UNKNOWN_FLAG = 0x00010000;

// The fixture: version 0x00020001, flags 0, a 180-byte header that ends with an empty RootString,
// then test-font.ttf byte for byte.
const FIXTURE_HEADER_SIZE_BYTES = 180;

// The sfnt fields the spec edits in the enclosed font, by their offset (OpenType 1.9.1, Table
// Directory, head, maxp): in the sfnt, in a table record and in the table. Unlike the EOT header,
// the sfnt is big-endian.
const SFNT_VERSION_OFFSET_BYTES = 0;
const SFNT_NUM_TABLES_OFFSET_BYTES = 4;
const SFNT_HEADER_SIZE_BYTES = 12;
const SFNT_RECORD_SIZE_BYTES = 16;
const SFNT_TAG_SIZE_BYTES = 4;
const TABLE_OFFSET_OFFSET_BYTES = 8;
const LENGTH_OFFSET_BYTES = 12;
const INDEX_TO_LOC_FORMAT_OFFSET_BYTES = 50;
const NUM_GLYPHS_OFFSET_BYTES = 4;
const TTC_TAG = 0x74746366;
// A glyf filled with this byte opens glyph 0 with numberOfContours 0x7f7f: a simple glyph whose
// endPtsOfContours alone run past it.
const GLYF_GARBAGE_BYTE = 0x7f;
const GARBAGE_BYTE = 0xab;
const GARBAGE_SIZE_BYTES = 1024;

/**
 * A break of the enclosed font with the answer `SfntFontValidator` gives on it.
 */
type FontBreak = {
    name: string;
    font: () => Uint8Array;
    expected: new (...params: never) => InvalidSfntFont;
    /** The rule a `BrokenSfnt` names. */
    rule?: SfntRule;
};

/**
 * A block of the variable part: a name, RootString or Signature.
 */
type Block = {
    padding: number;
    content: Uint8Array;
};

/**
 * The fields version 0x00020002 adds after RootString (§3.3). `checkSum` left out is computed
 * from RootString.
 */
type Tail = {
    checkSum?: number;
    eudcCodePage: number;
    signature: Block;
    eudcFlags: number;
    eudcFont: Uint8Array;
};

/**
 * What `build()` lays out into an EOT. EOTSize and FontDataSize are computed.
 */
type Layout = {
    /** The fixed part up to Padding1: Version and Flags are overwritten from the fields below. */
    fixedPart: Uint8Array;
    version: number;
    flags: number;
    /** FamilyName, StyleName, VersionName, FullName; the padding of the first is Padding1. */
    names: Array<Block>;
    /** Absent in version 0x00010000. */
    rootString: Block | undefined;
    /** Only in version 0x00020002. */
    tail: Tail | undefined;
    /** Bytes between the header and FontData, which the submission does not allow. */
    gap: Uint8Array;
    font: Uint8Array;
};

describe("EotFontValidator.validate", function () {
    let workDir: string;
    // The file every variant is written to: each answer names it in its payload.
    let fontPath: string;
    let fixture: Uint8Array;
    let fixtureLayout: Layout;
    // Made by sfntly: version 0x00020002, TTEMBED_TTCOMPRESSED (test/fixtures/fonts/README.md).
    let compressedFixture: Uint8Array;
    let otf: Uint8Array;
    let woff: Uint8Array;

    before(async function () {
        fixture = await readFixture(Extension.EOT);
        fixtureLayout = parse(fixture);
        compressedFixture = Uint8Array.from(await fs.readFile(path.join(fixtureDir, "test-font-compressed.eot")));
        otf = await readFixture(Extension.OTF);
        woff = await readFixture(Extension.WOFF);
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eot-font-validator-"));
        fontPath = path.join(workDir, `font.${Extension.EOT}`);
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it("the builder lays the fixture out byte for byte", function () {
        // Every variant below is built by it, so each one differs from a valid EOT by its own break alone.
        expect(Buffer.compare(build(fixtureLayout), fixture)).to.equal(0);
        expect(fixture.length - fixtureLayout.font.length).to.equal(FIXTURE_HEADER_SIZE_BYTES);
    });

    describe("accepts a valid font", function () {
        it("the Roboto fixture", async function () {
            await validate(fixture);
        });

        it("of version 0x00010000, which has no RootString", async function () {
            await validate(build({ ...fixtureLayout, version: VERSION_1_0, rootString: undefined }));
        });

        it("of version 0x00020002 with an empty RootString", async function () {
            await validate(build(version22()));
        });

        it("with a RootString in version 0x00020001", async function () {
            await validate(build({ ...fixtureLayout, rootString: rootString() }));
        });

        it("with a RootString and its checksum in version 0x00020002", async function () {
            await validate(build({ ...version22(), rootString: rootString() }));
        });

        it("with TTEMBED_SUBSET", async function () {
            await validate(build({ ...fixtureLayout, flags: TTEMBED_SUBSET }));
        });

        it("with a flag bit the submission does not list", async function () {
            await validate(build({ ...fixtureLayout, flags: UNKNOWN_FLAG }));
        });

        it("with an EUDC font in version 0x00020002", async function () {
            const layout = version22();

            await validate(
                build({ ...layout, tail: { ...(layout.tail as Tail), eudcFlags: 1, eudcFont: Uint8Array.from([1, 2, 3, 4, 5]) } }),
            );
        });

        it("with a signature of an odd size in version 0x00020002", async function () {
            // Signature is bytes, not UTF-16 text, and its size "should" be 0, which is not checked.
            const layout = version22();

            await validate(
                build({ ...layout, tail: { ...(layout.tail as Tail), signature: { padding: 0, content: Uint8Array.from([1, 2, 3]) } } }),
            );
        });

        it("with fsType and the family name differing from the font", async function () {
            const names = [{ padding: 0, content: utf16("Other Family") }, ...fixtureLayout.names.slice(1)];
            const differing = patch(build({ ...fixtureLayout, names: names }), (view) => view.setUint16(FS_TYPE, 0x0002, true));

            await validate(differing);
        });

        it("with the OTF fixture enclosed", async function () {
            await validate(build({ ...fixtureLayout, font: otf }));
        });

        it("with the TTF fixture without OS/2 enclosed: a font with TrueType outlines may lack it", async function () {
            await validate(build({ ...fixtureLayout, font: withoutTable(fixtureLayout.font, "OS/2") }));
        });

        it("with compressed FontData", async function () {
            await validate(compressedFixture);
        });

        it("with encrypted FontData", async function () {
            await validate(build({ ...fixtureLayout, flags: TTEMBED_XORENCRYPTDATA, font: xor(fixtureLayout.font) }));
        });

        it("with FontData both compressed and encrypted", async function () {
            const flags = TTEMBED_TTCOMPRESSED | TTEMBED_XORENCRYPTDATA;

            await validate(withFontData(compressedFixture, xor(fontDataOf(compressedFixture)), flags));
        });
    });

    describe("rejects a file that is not EOT", function () {
        it("a file shorter than the fixed part of the header", async function () {
            await expectAnswer(
                fixture.subarray(0, 81),
                NotEot,
                "File is not EOT: it is 81 bytes long, shorter than the 82-byte fixed part of the header.",
            );
        });

        it("a file whose MagicNumber is swapped", async function () {
            const swapped = patch(fixture, (view) => view.setUint16(MAGIC_NUMBER, 0x4c50, true));

            await expectAnswer(swapped, NotEot, "File is not EOT: its MagicNumber is 0x4c50, expected 0x504c.");
        });
    });

    describe("rejects a broken fixed part", function () {
        it("EOTSize greater than the file", async function () {
            const declared = patch(fixture, (view) => view.setUint32(EOT_SIZE, fixture.length + 1, true));

            await expectBroken(
                declared,
                EotRule.EotSize,
                `At the header: EOTSize is ${fixture.length + 1}, expected ${fixture.length}, the file size.`,
            );
        });

        it("EOTSize less than the file", async function () {
            const declared = patch(fixture, (view) => view.setUint32(EOT_SIZE, fixture.length - 1, true));

            await expectBroken(
                declared,
                EotRule.EotSize,
                `At the header: EOTSize is ${fixture.length - 1}, expected ${fixture.length}, the file size.`,
            );
        });

        it("an unknown version", async function () {
            await expectBroken(
                build({ ...fixtureLayout, version: 0x00030000 }),
                EotRule.Version,
                "At the header: Version is 0x00030000, expected one of 0x00010000, 0x00020001, 0x00020002.",
            );
        });

        it("Reserved1 that is not 0", async function () {
            const reserved = patch(fixture, (view) => view.setUint32(RESERVED_1, 1, true));

            await expectBroken(reserved, EotRule.Reserved, "At the header: Reserved1 is 0x00000001, expected 0.");
        });

        it("Reserved4 that is not 0", async function () {
            const reserved = patch(fixture, (view) => view.setUint32(RESERVED_4, 0xff000000, true));

            await expectBroken(reserved, EotRule.Reserved, "At the header: Reserved4 is 0xff000000, expected 0.");
        });
    });

    describe("rejects blocks and font data laid out against the submission", function () {
        it("version 0x00010000 over the layout of 0x00020001", async function () {
            // The RootString block of the fixture is left in front of the font.
            const relabelled = patch(fixture, (view) => view.setUint32(VERSION, VERSION_1_0, true));

            await expectFontDataLayout(relabelled, FIXTURE_HEADER_SIZE_BYTES - BLOCK_PREFIX_BYTES);
        });

        it("version 0x00020002 without its tail", async function () {
            // The tail is read from the first bytes of the font: the table records give a
            // SignatureSize of 20480 and an EUDCFontSize of 46662629, which runs past the file.
            const relabelled = patch(fixture, (view) => view.setUint32(VERSION, VERSION_2_2, true));

            await expectBroken(
                relabelled,
                EotRule.BlocksInFile,
                `At the header: end is 46683309, expected at most ${fixture.length}, the file size.`,
            );
        });

        it("a gap of zero bytes between the header and the font", async function () {
            await expectFontDataLayout(build({ ...fixtureLayout, gap: new Uint8Array(8) }), FIXTURE_HEADER_SIZE_BYTES);
        });

        it("a byte after the font", async function () {
            const trailing = Uint8Array.from([...fixture, 0]);
            const declared = patch(trailing, (view) => view.setUint32(EOT_SIZE, trailing.length, true));

            await expectFontDataLayout(declared, FIXTURE_HEADER_SIZE_BYTES);
        });

        it("FontDataSize 0", async function () {
            const empty = patch(fixture, (view) => view.setUint32(FONT_DATA_SIZE, 0, true));

            await expectBroken(empty, EotRule.FontDataLayout, "At the header: FontDataSize is 0, expected not 0.");
        });

        for (const [description, delta] of [
            ["less than the font", -4],
            ["greater than the font", 4],
            ["past the file", FIXTURE_HEADER_SIZE_BYTES + 1],
        ] as const) {
            it(`FontDataSize ${description}`, async function () {
                const fontDataSizeBytes = fixtureLayout.font.length + delta;
                const declared = patch(fixture, (view) => view.setUint32(FONT_DATA_SIZE, fontDataSizeBytes, true));

                await expectBroken(
                    declared,
                    EotRule.FontDataLayout,
                    `At FontData: the header end ${FIXTURE_HEADER_SIZE_BYTES} + FontDataSize ${fontDataSizeBytes} is ` +
                        `${FIXTURE_HEADER_SIZE_BYTES + fontDataSizeBytes}, expected ${fixture.length}, EOTSize.`,
                );
            });
        }

        it("a RootString size that runs into the font", async function () {
            // The last block of version 0x00020001: the header end moves past the font start.
            const overlapping = patch(fixture, (view) => view.setUint16(FIXTURE_HEADER_SIZE_BYTES - 2, 4, true));

            await expectFontDataLayout(overlapping, FIXTURE_HEADER_SIZE_BYTES + 4);
        });

        it("a RootString size that runs past the end of the file", async function () {
            const layout = { ...fixtureLayout, font: fixtureLayout.font.subarray(0, 16) };
            const short = build(layout);
            const overlong = patch(short, (view) => view.setUint16(FIXTURE_HEADER_SIZE_BYTES - 2, 0x1000, true));

            await expectBroken(
                overlong,
                EotRule.BlocksInFile,
                `At the header: end is ${FIXTURE_HEADER_SIZE_BYTES + 0x1000}, expected at most ${short.length}, the file size.`,
            );
        });

        it("a name size that leaves the next block past the end of the file", async function () {
            // The parse cannot read the size of StyleName: its answer stays as the cause.
            const short = build({ ...fixtureLayout, font: fixtureLayout.font.subarray(0, 16) });
            const overlong = patch(short, (view) => view.setUint16(FIXED_PART_BEFORE_PADDING_1_BYTES + 2, 0x1000, true));

            const error = await expectBroken(
                overlong,
                EotRule.BlocksInFile,
                `At the header: the file size is ${short.length}, expected room for every field of the header of version 0x00020001.`,
            );

            expect(error.cause).to.be.instanceOf(InvalidEot);
        });

        it("a SignatureSize that leaves EUDCFlags and EUDCFontSize past the end of the file", async function () {
            // Neither field is a Padding or a block size, and the parse cannot read them either.
            const layout = { ...version22(), font: fixtureLayout.font.subarray(0, 16) };
            const short = build(layout);
            const headerEnd = short.length - layout.font.length;
            // SignatureSize lies before the empty signature, EUDCFlags and EUDCFontSize. Grown by the
            // font size + 4, the signature puts EUDCFlags 4 bytes before the end of the file.
            const signatureSizeOffset = headerEnd - 2 * 4 - 2;
            const overlong = patch(short, (view) => view.setUint16(signatureSizeOffset, layout.font.length + 4, true));

            const error = await expectBroken(
                overlong,
                EotRule.BlocksInFile,
                `At the header: the file size is ${short.length}, expected room for every field of the header of version 0x00020002.`,
            );

            expect(error.cause).to.be.instanceOf(InvalidEot);
        });

        it("an EUDCFontSize that runs into the font", async function () {
            const layout = version22();
            const eudcFont = Uint8Array.from([1, 2, 3, 4]);
            const valid = build({ ...layout, tail: { ...(layout.tail as Tail), eudcFont: eudcFont } });
            const headerEnd = valid.length - layout.font.length;
            const overlapping = patch(valid, (view) => view.setUint32(headerEnd - eudcFont.length - 4, eudcFont.length + 4, true));

            await expectFontDataLayout(overlapping, headerEnd + 4);
        });

        it("an EUDCFontSize that runs past the end of the file", async function () {
            const layout = version22();
            const valid = build(layout);
            const headerEnd = valid.length - layout.font.length;
            const overlong = patch(valid, (view) => view.setUint32(headerEnd - 4, 0xffffffff, true));

            await expectBroken(
                overlong,
                EotRule.BlocksInFile,
                `At the header: end is ${headerEnd + 0xffffffff}, expected at most ${valid.length}, the file size.`,
            );
        });
    });

    describe("rejects broken values in the blocks", function () {
        for (const [index, field, name] of [
            [0, "Padding1", "FamilyName"],
            [1, "Padding2", "StyleName"],
            [2, "Padding3", "VersionName"],
            [3, "Padding4", "FullName"],
        ] as const) {
            it(`${field} that is not 0`, async function () {
                const names = fixtureLayout.names.map((block, at) => (at === index ? { ...block, padding: 0x0100 } : block));

                await expectBroken(
                    build({ ...fixtureLayout, names: names }),
                    EotRule.Padding,
                    `At the block of ${name}: ${field} is 0x0100, expected 0x0000.`,
                );
            });
        }

        it("Padding5 that is not 0", async function () {
            await expectBroken(
                build({ ...fixtureLayout, rootString: { padding: 1, content: new Uint8Array() } }),
                EotRule.Padding,
                "At the block of RootString: Padding5 is 0x0001, expected 0x0000.",
            );
        });

        it("Padding6 that is not 0", async function () {
            const layout = version22();

            await expectBroken(
                build({ ...layout, tail: { ...(layout.tail as Tail), signature: { padding: 1, content: new Uint8Array() } } }),
                EotRule.Padding,
                "At the block of Signature: Padding6 is 0x0001, expected 0x0000.",
            );
        });

        it("a name of an odd size", async function () {
            const familyName = fixtureLayout.names[0] as Block;
            const names = [{ padding: 0, content: Uint8Array.from([...familyName.content, 0x41]) }, ...fixtureLayout.names.slice(1)];

            await expectBroken(
                build({ ...fixtureLayout, names: names }),
                EotRule.EvenSize,
                `At the block of FamilyName: FamilyNameSize is ${familyName.content.length + 1}, expected an even number of bytes.`,
            );
        });

        it("a RootString of an odd size", async function () {
            await expectBroken(
                build({ ...fixtureLayout, rootString: { padding: 0, content: Uint8Array.from([0x41]) } }),
                EotRule.EvenSize,
                "At the block of RootString: RootStringSize is 1, expected an even number of bytes.",
            );
        });

        it("a wrong RootStringCheckSum", async function () {
            const layout = version22();
            const content = utf16("http://example.com/");
            const checkSum = (byteSum(content) ^ ROOT_STRING_CHECKSUM_KEY) >>> 0;

            await expectBroken(
                build({
                    ...layout,
                    rootString: { padding: 0, content: content },
                    tail: { ...(layout.tail as Tail), checkSum: checkSum + 1 },
                }),
                EotRule.RootStringCheckSum,
                `At the header: RootStringCheckSum is ${hex(checkSum + 1)}, expected ${hex(checkSum)}.`,
            );
        });
    });

    describe("rejects FontData that does not decode under its flags", function () {
        const cases = [
            {
                name: "compressed data cut in half",
                font: (): Uint8Array => {
                    const fontData = fontDataOf(compressedFixture);

                    return withFontData(compressedFixture, fontData.slice(0, fontData.length / 2), TTEMBED_TTCOMPRESSED);
                },
                flags: TTEMBED_TTCOMPRESSED,
            },
            {
                name: "compressed data with bytes overwritten",
                font: () => withFontData(compressedFixture, overwritten(fontDataOf(compressedFixture)), TTEMBED_TTCOMPRESSED),
                flags: TTEMBED_TTCOMPRESSED,
            },
            {
                name: "TTEMBED_TTCOMPRESSED over a plain sfnt",
                font: (): Uint8Array => build({ ...fixtureLayout, flags: TTEMBED_TTCOMPRESSED | TTEMBED_SUBSET }),
                flags: TTEMBED_TTCOMPRESSED | TTEMBED_SUBSET,
            },
        ];

        for (const { name, font, flags } of cases) {
            it(name, async function () {
                const error = await expectBroken(
                    font(),
                    EotRule.FontDataDecodes,
                    `At FontData: Flags is ${hex(flags)}, expected FontData that decodes under them.`,
                );

                expect(error.cause).to.be.instanceOf(InvalidEotPayload);
            });
        }

        it("TTEMBED_XORENCRYPTDATA over a plain sfnt, with the answer of SfntFontValidator on what it decodes into", async function () {
            // XOR decodes any bytes, so the decoded garbage is left to the sfnt validator.
            const error = await expectRejection(() => validate(build({ ...fixtureLayout, flags: TTEMBED_XORENCRYPTDATA })), NotSfnt);

            expect(error.payload).to.include({ path: fontPath });
        });
    });

    // The breaks measured in issue #740: the codec rejects the first four by the sfnt header alone
    // and lets the rest through, and on eot → ttf the engine is not called.
    describe("rejects a broken enclosed font with the answer of SfntFontValidator", function () {
        const breaks: ReadonlyArray<FontBreak> = [
            { name: "a WOFF", font: () => woff, expected: NotSfnt },
            { name: "garbage", font: () => new Uint8Array(GARBAGE_SIZE_BYTES).fill(GARBAGE_BYTE), expected: NotSfnt },
            {
                name: "a collection",
                font: () => withUint32(fixtureLayout.font, SFNT_VERSION_OFFSET_BYTES, TTC_TAG),
                expected: BrokenSfnt,
                rule: SfntRule.Collection,
            },
            {
                name: "the sfnt header alone",
                font: () => fixtureLayout.font.slice(0, SFNT_HEADER_SIZE_BYTES),
                expected: BrokenSfnt,
                rule: SfntRule.DirectoryInFile,
            },
            {
                name: "numTables 0",
                font: () => withUint16(fixtureLayout.font, SFNT_NUM_TABLES_OFFSET_BYTES, 0),
                expected: BrokenSfnt,
                rule: SfntRule.TablesPresent,
            },
            {
                name: "cut in half",
                font: () => fixtureLayout.font.slice(0, fixtureLayout.font.length / 2),
                expected: BrokenSfnt,
                rule: SfntRule.TableInFile,
            },
            {
                name: "without its last byte",
                font: () => fixtureLayout.font.slice(0, -1),
                expected: BrokenSfnt,
                rule: SfntRule.TableInFile,
            },
            { name: "without glyf", font: () => withoutTable(fixtureLayout.font, "glyf"), expected: BrokenSfnt, rule: SfntRule.Outlines },
            ...["head", "cmap", "name"].map((tag) => ({
                name: `without ${tag}`,
                font: () => withoutTable(fixtureLayout.font, tag),
                expected: BrokenSfnt,
                rule: SfntRule.RequiredTable,
            })),
            {
                name: "maxp.numGlyphs 0",
                font: () => withUint16(fixtureLayout.font, tableOffset(fixtureLayout.font, "maxp") + NUM_GLYPHS_OFFSET_BYTES, 0),
                expected: BrokenSfnt,
                rule: SfntRule.NotdefGlyph,
            },
            {
                name: "head.indexToLocFormat 2",
                font: () => withUint16(fixtureLayout.font, tableOffset(fixtureLayout.font, "head") + INDEX_TO_LOC_FORMAT_OFFSET_BYTES, 2),
                expected: BrokenSfnt,
                rule: SfntRule.IndexToLocFormat,
            },
            {
                name: "a glyf of garbage",
                font: () => withTableFilled(fixtureLayout.font, "glyf", GLYF_GARBAGE_BYTE),
                expected: BrokenSfnt,
                rule: SfntRule.SimpleGlyphInData,
            },
        ];

        for (const { name, font, expected, rule } of breaks) {
            it(name, async function () {
                const enclosed = font();
                const direct = await expectRejection(async () => sfntFontValidator.validateBytes(fontPath, enclosed), expected);
                const error = await expectRejection(() => validate(build({ ...fixtureLayout, font: enclosed })), expected, direct.message);

                // The answer passes through as is, and its payload names the EOT file.
                expect(error.payload).to.deep.equal(direct.payload);
                expect(error.payload).to.include({ path: fontPath });

                if (rule !== undefined) {
                    expect(error.payload).to.include({ rule: rule });
                }
            });
        }
    });

    it("fails with ReadFailed on a file that cannot be read", async function () {
        await expectRejection(() => validator.validate(path.join(workDir, "missing.eot")), ReadFailed);
    });

    function version22(): Layout {
        return {
            ...fixtureLayout,
            version: VERSION_2_2,
            tail: { eudcCodePage: 0, signature: { padding: 0, content: new Uint8Array() }, eudcFlags: 0, eudcFont: new Uint8Array() },
        };
    }

    async function validate(content: Uint8Array): Promise<void> {
        await fs.writeFile(fontPath, content);
        await validator.validate(fontPath);
    }

    /**
     * Checks, besides the class and the message, that the answer names the rejected file, as every
     * answer of the validator does.
     */
    async function expectAnswer<T extends InvalidEotFont>(
        content: Uint8Array,
        expected: new (...params: never) => T,
        message?: string,
    ): Promise<T> {
        const error = await expectRejection(() => validate(content), expected, message);

        expect(error.payload).to.include({ path: fontPath });

        return error;
    }

    /**
     * `where` is the message past the rule: the part that names the place, the value and the
     * expected one.
     */
    async function expectBroken(content: Uint8Array, rule: EotRule, where: string): Promise<BrokenEot> {
        const error = await expectAnswer(content, BrokenEot, `EOT breaks a rule: ${rule}. ${where}`);

        expect(error.payload).to.include({ rule: rule });

        return error;
    }

    /**
     * The font fills the file from its start by FontDataSize, while the header ends at `headerEnd`.
     */
    async function expectFontDataLayout(content: Uint8Array, headerEnd: number): Promise<void> {
        const fontDataSizeBytes = new DataView(content.buffer, content.byteOffset).getUint32(FONT_DATA_SIZE, true);

        await expectBroken(
            content,
            EotRule.FontDataLayout,
            `At FontData: the header end ${headerEnd} + FontDataSize ${fontDataSizeBytes} is ${headerEnd + fontDataSizeBytes}, ` +
                `expected ${content.length}, EOTSize.`,
        );
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
 * The layout of an EOT of version 0x00020001, as the fixture is.
 */
function parse(eot: Uint8Array): Layout {
    const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength);
    const blocks: Array<Block> = [];
    let offset = FIXED_PART_BEFORE_PADDING_1_BYTES;

    // The four names and RootString.
    for (let index = 0; index < 5; index++) {
        const sizeBytes = view.getUint16(offset + 2, true);

        blocks.push({
            padding: view.getUint16(offset, true),
            content: eot.slice(offset + BLOCK_PREFIX_BYTES, offset + BLOCK_PREFIX_BYTES + sizeBytes),
        });
        offset += BLOCK_PREFIX_BYTES + sizeBytes;
    }

    return {
        fixedPart: eot.slice(0, FIXED_PART_BEFORE_PADDING_1_BYTES),
        version: view.getUint32(VERSION, true),
        flags: view.getUint32(FLAGS, true),
        names: blocks.slice(0, 4),
        rootString: blocks[4],
        tail: undefined,
        gap: new Uint8Array(),
        font: eot.slice(offset),
    };
}

function build(layout: Layout): Uint8Array {
    const blocks = [...layout.names, ...(layout.rootString === undefined ? [] : [layout.rootString])].map(encodeBlock);
    const tail = layout.tail === undefined ? [] : [encodeTail(layout.tail, layout.rootString?.content ?? new Uint8Array())];
    const eot = Uint8Array.from(Buffer.concat([layout.fixedPart, ...blocks, ...tail, layout.gap, layout.font]));
    const view = new DataView(eot.buffer);

    view.setUint32(EOT_SIZE, eot.length, true);
    view.setUint32(FONT_DATA_SIZE, layout.font.length, true);
    view.setUint32(VERSION, layout.version, true);
    view.setUint32(FLAGS, layout.flags, true);

    return eot;
}

function encodeBlock({ padding, content }: Block): Uint8Array {
    const bytes = new Uint8Array(BLOCK_PREFIX_BYTES + content.length);
    const view = new DataView(bytes.buffer);

    view.setUint16(0, padding, true);
    view.setUint16(2, content.length, true);
    bytes.set(content, BLOCK_PREFIX_BYTES);

    return bytes;
}

/**
 * RootStringCheckSum, EUDCCodePage, Padding6, SignatureSize with Signature, EUDCFlags, EUDCFontSize
 * with EUDCFontData.
 */
function encodeTail(tail: Tail, rootString: Uint8Array): Uint8Array {
    const head = new Uint8Array(8);
    const middle = new Uint8Array(8);

    new DataView(head.buffer).setUint32(0, tail.checkSum ?? (byteSum(rootString) ^ ROOT_STRING_CHECKSUM_KEY) >>> 0, true);
    new DataView(head.buffer).setUint32(4, tail.eudcCodePage, true);
    new DataView(middle.buffer).setUint32(0, tail.eudcFlags, true);
    new DataView(middle.buffer).setUint32(4, tail.eudcFont.length, true);

    return Uint8Array.from(Buffer.concat([head, encodeBlock(tail.signature), middle, tail.eudcFont]));
}

function rootString(): Block {
    return { padding: 0, content: utf16("http://example.com/ https://example.org/") };
}

function byteSum(bytes: Uint8Array): number {
    return bytes.reduce((sum, byte) => sum + byte, 0);
}

function utf16(text: string): Uint8Array {
    return Uint8Array.from(Buffer.from(text, "utf16le"));
}

function patch(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
    const copy = Uint8Array.from(bytes);

    mutate(new DataView(copy.buffer));

    return copy;
}

/**
 * The sfnt without the table record of `tag`: the table itself stays where it was.
 */
function withoutTable(font: Uint8Array, tag: string): Uint8Array {
    const recordOffset = recordOf(font, tag);
    const numTables = readUint16(font, SFNT_NUM_TABLES_OFFSET_BYTES);
    const directoryEnd = SFNT_HEADER_SIZE_BYTES + numTables * SFNT_RECORD_SIZE_BYTES;
    const copy = Uint8Array.from(font);

    copy.copyWithin(recordOffset, recordOffset + SFNT_RECORD_SIZE_BYTES, directoryEnd);
    copy.fill(0, directoryEnd - SFNT_RECORD_SIZE_BYTES, directoryEnd);

    return withUint16(copy, SFNT_NUM_TABLES_OFFSET_BYTES, numTables - 1);
}

function withTableFilled(font: Uint8Array, tag: string, byte: number): Uint8Array {
    const copy = Uint8Array.from(font);
    const start = tableOffset(font, tag);

    copy.fill(byte, start, start + readUint32(font, recordOf(font, tag) + LENGTH_OFFSET_BYTES));

    return copy;
}

function tableOffset(font: Uint8Array, tag: string): number {
    return readUint32(font, recordOf(font, tag) + TABLE_OFFSET_OFFSET_BYTES);
}

/**
 * The offset of the table record of `tag` in the sfnt.
 */
function recordOf(font: Uint8Array, tag: string): number {
    const numTables = readUint16(font, SFNT_NUM_TABLES_OFFSET_BYTES);

    for (let index = 0; index < numTables; index++) {
        const recordOffset = SFNT_HEADER_SIZE_BYTES + index * SFNT_RECORD_SIZE_BYTES;

        if (Buffer.from(font.subarray(recordOffset, recordOffset + SFNT_TAG_SIZE_BYTES)).toString("latin1") === tag) {
            return recordOffset;
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
    return patch(bytes, (view) => view.setUint16(offset, value));
}

function withUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    return patch(bytes, (view) => view.setUint32(offset, value));
}

/**
 * The envelope with its FontData replaced and its flags set, the sizes in the header following.
 */
function withFontData(eot: Uint8Array, fontData: Uint8Array, flags: number): Uint8Array {
    const header = eot.subarray(0, eot.length - fontDataOf(eot).length);
    const replaced = Uint8Array.from(Buffer.concat([header, fontData]));
    const view = new DataView(replaced.buffer);

    view.setUint32(EOT_SIZE, replaced.length, true);
    view.setUint32(FONT_DATA_SIZE, fontData.length, true);
    view.setUint32(FLAGS, flags, true);

    return replaced;
}

function hex(value: number): string {
    return `0x${value.toString(16).padStart(8, "0")}`;
}

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
