import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { EotHeader } from "app/font-convertor/eot-header/eot-header";
import { InvalidEot } from "app/font-convertor/eot-header/eot-header.errors";
import type { EotBlock } from "app/font-convertor/eot-header/eot-header.types";
import { Extension } from "app/font-convertor/font-convertor.types";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The offsets of the fixed part by the submission, §3. The fixture is version 0x00020001: a
// 180-byte header that ends with an empty RootString, then test-font.ttf byte for byte.
const EOT_SIZE_OFFSET = 0;
const FONT_DATA_SIZE_OFFSET = 4;
const VERSION_OFFSET = 8;
const FLAGS_OFFSET = 12;
const MAGIC_NUMBER_OFFSET = 34;
const RESERVED_OFFSET = 64;
const PADDING_1_OFFSET = 80;
const FIXED_SIZE_BYTES = 82;
const ROOT_STRING_BLOCK_BYTES = 4;
const ROOT_STRING_CHECKSUM_KEY = 0x50475342;
const ENVELOPE_PREFIX_BYTES = 8;

describe("EotHeader", function () {
    let ttf: Uint8Array;
    let eot: Uint8Array;
    // The fixture header without its RootString block: the fixed part and the four names.
    let namesPart: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
        eot = await readFixture(Extension.EOT);
        namesPart = eot.subarray(0, eot.length - ttf.length - ROOT_STRING_BLOCK_BYTES);
    });

    describe("the fixed part", function () {
        it("reads the fixed part of the fixture", function () {
            const header = new EotHeader(eot);

            expect(header.eotSizeBytes, "EOTSize").to.equal(eot.length);
            expect(header.fontDataSizeBytes, "FontDataSize").to.equal(ttf.length);
            expect(header.version, "Version").to.equal(EotHeader.VERSION_2_1);
            expect(header.flags, "Flags").to.equal(0);
            expect(header.magicNumber, "MagicNumber").to.equal(EotHeader.MAGIC_NUMBER);
            expect(header.reserved, "Reserved1..4").to.deep.equal([0, 0, 0, 0]);
        });

        it("reads each field of the fixed part from its own offset", function () {
            // The fixture has zero in Flags and in every Reserved field, and zero would read the
            // same from any of them, so each field gets a value of its own.
            const marked = patch(eot, (view) => {
                view.setUint32(EOT_SIZE_OFFSET, 0x01020304, true);
                view.setUint32(FONT_DATA_SIZE_OFFSET, 0x05060708, true);
                view.setUint32(VERSION_OFFSET, 0x090a0b0c, true);
                view.setUint32(FLAGS_OFFSET, 0x0d0e0f10, true);
                view.setUint16(MAGIC_NUMBER_OFFSET, 0x1112, true);
                [0x13141516, 0x1718191a, 0x1b1c1d1e, 0x1f202122].forEach((value, index) =>
                    view.setUint32(RESERVED_OFFSET + index * 4, value, true),
                );
            });

            const header = new EotHeader(marked);

            expect(header.eotSizeBytes, "EOTSize").to.equal(0x01020304);
            expect(header.fontDataSizeBytes, "FontDataSize").to.equal(0x05060708);
            expect(header.version, "Version").to.equal(0x090a0b0c);
            expect(header.flags, "Flags").to.equal(0x0d0e0f10);
            expect(header.magicNumber, "MagicNumber").to.equal(0x1112);
            expect(header.reserved, "Reserved1..4").to.deep.equal([0x13141516, 0x1718191a, 0x1b1c1d1e, 0x1f202122]);
        });

        it("reads a header that lies inside a larger buffer", function () {
            // A reader may hand the envelope over as a view, so it does not start at the
            // beginning of its buffer.
            const prefixed = Uint8Array.from(Buffer.concat([Buffer.alloc(ENVELOPE_PREFIX_BYTES, 0xff), eot]));
            const header = new EotHeader(prefixed.subarray(ENVELOPE_PREFIX_BYTES));

            expect(header.eotSizeBytes).to.equal(eot.length);
            expect(header.readNames().endOffset).to.equal(eot.length - ttf.length);
            expect(header.readFontDataOffset()).to.equal(eot.length - ttf.length);
        });

        it("rejects a file cut off inside the fixed part", function () {
            // Without the length check DataView would throw a RangeError instead of InvalidEot.
            expect(() => new EotHeader(eot.subarray(0, FIXED_SIZE_BYTES - 1))).to.throw(InvalidEot);
        });
    });

    describe("the names", function () {
        it("reads the four names and the empty root string of version 0x00020001", function () {
            const header = new EotHeader(eot);
            const names = header.readNames();

            expect(decode(eot, names.familyName), "FamilyName").to.equal("Roboto Black");
            expect(decode(eot, names.styleName), "StyleName").to.equal("Black");
            expect(decode(eot, names.versionName), "VersionName").to.equal("Version 1.0");
            expect(decode(eot, names.fullName), "FullName").to.equal("Roboto-Black");
            expect(names.rootString, "RootString").to.deep.equal({ padding: 0, offset: eot.length - ttf.length, sizeBytes: 0 });
            expect(names.endOffset, "the end of the names").to.equal(eot.length - ttf.length);
        });

        it("reads the four names of version 1.0, which has no root string", function () {
            // In version 1.0 the header ends with the full name: the fixture without its
            // RootString block, Padding5 and RootStringSize.
            const legacy = envelope(EotHeader.VERSION_1_0, [namesPart]);
            const names = new EotHeader(legacy).readNames();

            expect(decode(legacy, names.fullName), "FullName").to.equal("Roboto-Black");
            expect(names.rootString, "RootString").to.equal(undefined);
            expect(names.endOffset, "the end of the names").to.equal(namesPart.length);
        });

        it("reads the root string of version 0x00020001", function () {
            const rooted = envelope(EotHeader.VERSION_2_1, [namesPart, block(0, utf16("https://example.com"))]);
            const names = new EotHeader(rooted).readNames();

            if (names.rootString === undefined) {
                expect.fail("RootString not read");
            }

            expect(decode(rooted, names.rootString)).to.equal("https://example.com");
            expect(names.endOffset).to.equal(rooted.length - ttf.length);
        });

        it("reads the padding in front of each block", function () {
            // The fixture has zero in every padding, and zero would read the same from any of
            // them, so each padding gets a value of its own.
            const paddingOffsets = paddingOffsetsOf(eot);
            const padded = patch(eot, (view) =>
                paddingOffsets.forEach((offset, index) => view.setUint16(offset, 0x0101 * (index + 1), true)),
            );
            const names = new EotHeader(padded).readNames();

            expect(
                [names.familyName, names.styleName, names.versionName, names.fullName, names.rootString].map((name) => name?.padding),
            ).to.deep.equal([0x0101, 0x0202, 0x0303, 0x0404, 0x0505]);
        });

        it("reports a block running past the end of the file as declared", function () {
            // The extent of a block is left to the readers: the codec compares it with the font
            // start, and rejecting it here would change that answer.
            const inflated = patch(eot, (view) => view.setUint16(eot.length - ttf.length - 2, 0xffff, true));

            expect(new EotHeader(inflated).readNames().endOffset).to.equal(eot.length - ttf.length + 0xffff);
        });

        it("reads a name size that ends exactly at the end of the file", function () {
            // Version 1.0 cut right after FullNameSize, set to zero: the last field the walk reads
            // ends where the file does.
            const fullNameSizeEnd = (paddingOffsetsOf(eot)[3] as number) + 4;
            const cut = patch(eot.subarray(0, fullNameSizeEnd), (view) => {
                view.setUint32(VERSION_OFFSET, EotHeader.VERSION_1_0, true);
                view.setUint16(fullNameSizeEnd - 2, 0, true);
            });

            expect(new EotHeader(cut).readNames().endOffset).to.equal(fullNameSizeEnd);
        });

        it("rejects a file that ends inside a name size", function () {
            // The file breaks off one byte short of the end of StyleNameSize. Without the check
            // DataView would throw a RangeError instead of InvalidEot.
            const styleNameSizeEnd = (paddingOffsetsOf(eot)[1] as number) + 4;

            expect(() => new EotHeader(eot.subarray(0, styleNameSizeEnd - 1)).readNames()).to.throw(InvalidEot);
        });

        it("rejects an unknown version", function () {
            const unknown = patch(eot, (view) => view.setUint32(VERSION_OFFSET, 0x00030000, true));

            expect(() => new EotHeader(unknown).readNames()).to.throw(InvalidEot);
        });
    });

    describe("the tail of version 0x00020002", function () {
        it("reads the tail a writer of an empty root string produces", function () {
            const tailed = envelope(EotHeader.VERSION_2_2, [namesPart, block(0, new Uint8Array()), emptyTail()]);
            const fontDataOffset = tailed.length - ttf.length;

            expect(new EotHeader(tailed).readTail()).to.deep.equal({
                rootStringCheckSum: ROOT_STRING_CHECKSUM_KEY,
                eudcCodePage: 0,
                signature: { padding: 0, offset: fontDataOffset - 8, sizeBytes: 0 },
                eudcFlags: 0,
                eudcFontOffset: fontDataOffset,
                eudcFontSizeBytes: 0,
                endOffset: fontDataOffset,
            });
        });

        it("reads each field of the tail from its own place", function () {
            const signature = Uint8Array.of(1, 2, 3);
            const eudcFont = Uint8Array.of(4, 5, 6, 7, 8);
            const tailed = envelope(EotHeader.VERSION_2_2, [
                namesPart,
                block(0, new Uint8Array()),
                tail({
                    checkSum: 0x0a0b0c0d,
                    eudcCodePage: 0x01020304,
                    padding6: 0x0506,
                    signature: signature,
                    eudcFlags: 0x0708090a,
                    eudcFont: eudcFont,
                }),
            ]);
            const fontDataOffset = tailed.length - ttf.length;
            const parsed = new EotHeader(tailed).readTail();

            if (parsed === undefined) {
                expect.fail("the tail not read");
            }

            expect(parsed.rootStringCheckSum, "RootStringCheckSum").to.equal(0x0a0b0c0d);
            expect(parsed.eudcCodePage, "EUDCCodePage").to.equal(0x01020304);
            expect(parsed.signature.padding, "Padding6").to.equal(0x0506);
            expect(
                hex(tailed.subarray(parsed.signature.offset, parsed.signature.offset + parsed.signature.sizeBytes)),
                "Signature",
            ).to.equal(hex(signature));
            expect(parsed.eudcFlags, "EUDCFlags").to.equal(0x0708090a);
            expect(hex(tailed.subarray(parsed.eudcFontOffset, parsed.eudcFontOffset + parsed.eudcFontSizeBytes)), "EUDCFontData").to.equal(
                hex(eudcFont),
            );
            expect(parsed.endOffset, "the end of the tail").to.equal(fontDataOffset);
        });

        it("has no tail in the earlier versions", function () {
            const legacy = envelope(EotHeader.VERSION_1_0, [namesPart]);

            expect(new EotHeader(legacy).readTail(), "0x00010000").to.equal(undefined);
            expect(new EotHeader(eot).readTail(), "0x00020001").to.equal(undefined);
        });

        it("rejects an unknown version", function () {
            const unknown = patch(eot, (view) => view.setUint32(VERSION_OFFSET, 0x00030000, true));

            expect(() => new EotHeader(unknown).readTail()).to.throw(InvalidEot);
        });

        // Each cut leaves the file one byte short of the end of a group of fields the tail reads
        // at once. Without the check DataView would throw a RangeError instead of InvalidEot.
        const cuts = [
            { name: "inside EUDCCodePage", fieldsEndBytes: 8 },
            { name: "inside SignatureSize", fieldsEndBytes: 12 },
            { name: "inside EUDCFontSize", fieldsEndBytes: 20 },
        ];

        for (const { name, fieldsEndBytes } of cuts) {
            it(`rejects a file that ends ${name}`, function () {
                const tailed = envelope(EotHeader.VERSION_2_2, [namesPart, block(0, new Uint8Array()), emptyTail()]);
                const tailOffset = namesPart.length + ROOT_STRING_BLOCK_BYTES;

                expect(() => new EotHeader(tailed.subarray(0, tailOffset + fieldsEndBytes - 1)).readTail()).to.throw(InvalidEot);
            });
        }
    });

    describe("the font data", function () {
        it("places the font at the end of the file", function () {
            expect(new EotHeader(eot).readFontDataOffset()).to.equal(eot.length - ttf.length);
        });

        it("rejects an envelope that declares no font data", function () {
            const empty = patch(eot, (view) => view.setUint32(FONT_DATA_SIZE_OFFSET, 0, true));

            expect(() => new EotHeader(empty).readFontDataOffset()).to.throw(InvalidEot);
        });

        it("rejects font data that does not fit behind the fixed part", function () {
            const oversized = patch(eot, (view) => view.setUint32(FONT_DATA_SIZE_OFFSET, eot.length - FIXED_SIZE_BYTES + 1, true));

            expect(() => new EotHeader(oversized).readFontDataOffset()).to.throw(InvalidEot);
        });
    });

    /**
     * An envelope of the given version from header parts and the TTF fixture, with EOTSize and
     * FontDataSize matching it.
     */
    function envelope(version: number, headerParts: Array<Uint8Array>): Uint8Array {
        const bytes = Uint8Array.from(Buffer.concat([...headerParts, ttf]));
        const view = new DataView(bytes.buffer);

        view.setUint32(EOT_SIZE_OFFSET, bytes.length, true);
        view.setUint32(FONT_DATA_SIZE_OFFSET, ttf.length, true);
        view.setUint32(VERSION_OFFSET, version, true);

        return bytes;
    }

    /**
     * The offsets of Padding1..5 in a version 0x00020001 header: each block is a padding, a size
     * and that many bytes.
     */
    function paddingOffsetsOf(bytes: Uint8Array): Array<number> {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const offsets: Array<number> = [];
        let offset = PADDING_1_OFFSET;

        for (let index = 0; index < 5; index++) {
            offsets.push(offset);
            offset += 4 + view.getUint16(offset + 2, true);
        }

        return offsets;
    }
});

/**
 * A block of the variable part: Padding (u16), size (u16), then the bytes.
 */
function block(padding: number, content: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(4 + content.length);
    const view = new DataView(bytes.buffer);

    view.setUint16(0, padding, true);
    view.setUint16(2, content.length, true);
    bytes.set(content, 4);

    return bytes;
}

/**
 * The tail of version 0x00020002 (§3.3): RootStringCheckSum, EUDCCodePage, Padding6,
 * SignatureSize with Signature, EUDCFlags, EUDCFontSize with EUDCFontData.
 */
function tail(fields: {
    checkSum: number;
    eudcCodePage: number;
    padding6: number;
    signature: Uint8Array;
    eudcFlags: number;
    eudcFont: Uint8Array;
}): Uint8Array {
    const { checkSum, eudcCodePage, padding6, signature, eudcFlags, eudcFont } = fields;
    const head = new Uint8Array(8);
    const middle = new Uint8Array(8);

    new DataView(head.buffer).setUint32(0, checkSum, true);
    new DataView(head.buffer).setUint32(4, eudcCodePage, true);
    new DataView(middle.buffer).setUint32(0, eudcFlags, true);
    new DataView(middle.buffer).setUint32(4, eudcFont.length, true);

    return Uint8Array.from(Buffer.concat([head, block(padding6, signature), middle, eudcFont]));
}

/**
 * The tail a writer of an empty RootString produces: RootStringCheckSum is the key alone, the rest
 * is zero, with no signature and no EUDC font.
 */
function emptyTail(): Uint8Array {
    return tail({
        checkSum: ROOT_STRING_CHECKSUM_KEY,
        eudcCodePage: 0,
        padding6: 0,
        signature: new Uint8Array(),
        eudcFlags: 0,
        eudcFont: new Uint8Array(),
    });
}

function decode(bytes: Uint8Array, name: EotBlock): string {
    return Buffer.from(bytes.subarray(name.offset, name.offset + name.sizeBytes)).toString("utf16le");
}

function utf16(text: string): Uint8Array {
    return Uint8Array.from(Buffer.from(text, "utf16le"));
}

function patch(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
    const copy = Uint8Array.from(bytes);

    mutate(new DataView(copy.buffer));

    return copy;
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
