import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SfntReader } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader";
import { InvalidSfnt } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The layout of the table directory and of the name records the spec walks, and the values it
// finds the fixture's name records by and writes into them to set up a case: platforms, an
// encoding, name IDs and a language.
const TABLE_DIRECTORY_OFFSET = 12;
const TABLE_RECORD_SIZE = 16;
const NAME_RECORD_SIZE = 12;
const PLATFORM_UNICODE = 0;
const PLATFORM_MACINTOSH = 1;
const PLATFORM_WINDOWS = 3;
const PLATFORM_UNKNOWN = 9;
const MAC_ENCODING_JAPANESE = 1;
const NAME_ID_FAMILY = 1;
const NAME_ID_STYLE = 2;
const NAME_ID_FULL = 4;
const NAME_ID_VERSION = 5;
const NAME_ID_POSTSCRIPT = 6;
const LANGUAGE_RUSSIAN = 0x0419;

describe("SfntReader.readMetadata", function () {
    let ttf: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
    });

    it("reads the fields the eot header duplicates", function () {
        const metadata = new SfntReader(ttf).readMetadata();

        expect({ ...metadata, panose: Array.from(metadata.panose) }).to.deep.equal({
            panose: [2, 0, 10, 3, 0, 0, 0, 0, 0, 0],
            italic: 0,
            weight: 900,
            fsType: 8,
            unicodeRange: [0xe000_02ff, 0x5000_205b, 0x20, 0],
            codePageRange: [0x2000_019f, 0],
            checkSumAdjustment: 0xeb67_c797,
            familyName: "Roboto Black",
            styleName: "Black",
            versionName: "Version 1.0",
            fullName: "Roboto-Black",
        });
    });

    it("reads a font with cff outlines the same way", async function () {
        const metadata = new SfntReader(await readFixture(Extension.OTF)).readMetadata();

        expect(metadata.familyName).to.equal("Roboto Black");
        expect(metadata.weight).to.equal(900);
        // The checksum is its own: the same font in another container is another file.
        expect(metadata.checkSumAdjustment).to.equal(0xf111_6829);
    });

    it("takes the italic flag from the os/2 table", function () {
        const os2 = tableOffset(ttf, "OS/2");
        const head = tableOffset(ttf, "head");

        expect(readMetadata(patch(ttf, (view) => view.setUint16(os2 + 62, 0x0001))).italic).to.equal(1);
        // Bit 5 of fsSelection is bold, which does not count as a slant.
        expect(readMetadata(patch(ttf, (view) => view.setUint16(os2 + 62, 0x0020))).italic).to.equal(0);
        // head.macStyle duplicates the slant but is not the one read: there the slant is bit 1
        // and bit 0 is bold, and mixing them up declares an italic font upright.
        expect(readMetadata(patch(ttf, (view) => view.setUint16(head + 44, 0x0002))).italic).to.equal(0);
    });

    it("falls back to the macintosh names when the font has no windows ones", function () {
        expect(readMetadata(withoutWindowsNames(ttf)).familyName).to.equal("Roboto Black");
        expect(readMetadata(withoutWindowsNames(ttf)).versionName).to.equal("Version 1.0");
    });

    it("falls back to the unicode names when the font has no windows ones", function () {
        // The Windows records are relabelled as Unicode — both platforms keep strings in
        // UTF-16BE — and the Macintosh records are hidden: their names are the same, and the text
        // would not show whose were read.
        const unicode = patch(withoutNames(ttf, PLATFORM_MACINTOSH), (view, copy) => {
            forEachNameRecord(copy, (record) => {
                if (view.getUint16(record) === PLATFORM_WINDOWS) {
                    view.setUint16(record, PLATFORM_UNICODE);
                    view.setUint16(record + 4, 0);
                }
            });
        });

        expect(envelopeNames(unicode)).to.deep.equal(["Roboto Black", "Black", "Version 1.0", "Roboto-Black"]);
    });

    it("reads the name from the last record of the table", function () {
        // The fixture's last record is the Windows PostScript name, which the envelope does not
        // need, so skipping the last record would change nothing. It is made the version name and
        // the real version record the PostScript name: the text shows which of the two was read.
        const lastVersion = patch(ttf, (view, copy) => {
            const name = tableOffset(copy, "name");
            const last = name + 6 + (view.getUint16(name + 2) - 1) * NAME_RECORD_SIZE;

            view.setUint16(nameRecord(copy, PLATFORM_WINDOWS, NAME_ID_VERSION) + 6, NAME_ID_POSTSCRIPT);
            view.setUint16(last + 6, NAME_ID_VERSION);
        });

        expect(readMetadata(lastVersion).versionName).to.equal("Roboto-Black");
    });

    // A string that ends right at a boundary fits; a boundary one byte shorter cuts it off. There
    // are two boundaries: the end of the file and the declared end of the name table — behind it
    // lies the neighbouring table, whose bytes are not a name although the file is whole. The
    // boundary is put at the Windows family name: the fixture keeps the other platforms' strings
    // further on, beyond it, so the name has nowhere else to be read from.
    const familyNameEndCases: Array<[string, (bytes: Uint8Array, end: number) => Uint8Array]> = [
        ["the end of the font", (bytes, end): Uint8Array => bytes.subarray(0, end)],
        ["the end of the name table", (bytes, end): Uint8Array => withNameTableLength(bytes, end - tableOffset(bytes, "name"))],
    ];

    for (const [boundary, cut] of familyNameEndCases) {
        it(`reads a name that ends right at ${boundary}`, function () {
            expect(readMetadata(cut(ttf, windowsFamilyNameEnd(ttf))).familyName).to.equal("Roboto Black");
        });

        it(`leaves out a name that ${boundary} cuts short`, function () {
            expect(readMetadata(cut(ttf, windowsFamilyNameEnd(ttf) - 1)).familyName).to.equal("");
        });
    }

    it("decodes the macintosh names as macroman, not latin-1", function () {
        // 0x8e is "é" in MacRoman and "Ž" in Latin-1: a byte on which the encodings differ.
        const renamed = patch(withoutWindowsNames(ttf), (_view, bytes) => {
            bytes[nameStringOffset(bytes, PLATFORM_MACINTOSH, NAME_ID_FAMILY)] = 0x8e;
        });

        expect(readMetadata(renamed).familyName).to.equal("éoboto Black");
    });

    it("skips a macintosh name in an encoding other than macroman", function () {
        // On the Macintosh platform only encodingId 0 is MacRoman, and a Japanese record holds
        // Shift-JIS: read as MacRoman, it would go into the envelope as garbage.
        const japanese = patch(withoutWindowsNames(ttf), (view, copy) => {
            view.setUint16(nameRecord(copy, PLATFORM_MACINTOSH, NAME_ID_FAMILY) + 2, MAC_ENCODING_JAPANESE);
        });
        const metadata = readMetadata(japanese);

        expect(metadata.familyName).to.equal("");
        // The record is skipped, not the platform: the neighbouring MacRoman names are read.
        expect(metadata.styleName).to.equal("Black");
    });

    // An offset from the start of the name table in the middle of the record with index 8: a
    // 6-byte header, eight whole records and half of the next one.
    const middleOfNameRecords = 6 + 8 * NAME_RECORD_SIZE + 6;

    // Subsetters cut name records, and `pyftsubset --drop-tables+=name` drops the whole table;
    // the envelope fields are informational, and rejecting the whole font over them costs more
    // than giving an empty string.
    const namelessCases: Array<[string, (bytes: Uint8Array) => Uint8Array]> = [
        ["carries no name records", (bytes): Uint8Array => patch(bytes, (view, copy) => view.setUint16(tableOffset(copy, "name") + 2, 0))],
        [
            "carries no name table",
            (bytes): Uint8Array => patch(bytes, (view, copy) => view.setUint32(tableRecord(copy, "name"), 0x78787878)),
        ],
        ["has a truncated name table", (bytes): Uint8Array => withNameTableLength(bytes, 4)],
        [
            "points its names past the end of the font",
            (bytes): Uint8Array =>
                patch(bytes, (view, copy) => {
                    forEachNameRecord(copy, (record): void => view.setUint16(record + 10, 0xffff));
                }),
        ],
        [
            "is cut off in the middle of the name records",
            // In a truncated font the string storage is past the end of the file, so the walk
            // over the records is ended by the end of the file. Without that boundary the
            // unfinished record with index 8 would be read past the end of the DataView and fail
            // the parse with a RangeError.
            (bytes): Uint8Array => bytes.subarray(0, tableOffset(bytes, "name") + middleOfNameRecords),
        ],
        [
            "declares its name table shorter than its name records",
            // The file is whole, only the declared length is shortened: the records behind it and
            // the string storage are no longer bytes of the name table.
            (bytes): Uint8Array => withNameTableLength(bytes, middleOfNameRecords),
        ],
        [
            "is cut off inside the name table header",
            // The record count is still in the file, the string storage offset is not: without
            // checking the header against the end of the file it would be read past the end of the
            // DataView.
            (bytes): Uint8Array => bytes.subarray(0, tableOffset(bytes, "name") + 4),
        ],
    ];

    for (const [what, damage] of namelessCases) {
        it(`leaves the envelope names empty when the font ${what}`, function () {
            const metadata = readMetadata(damage(ttf));

            expect([metadata.familyName, metadata.styleName, metadata.versionName, metadata.fullName]).to.deep.equal(["", "", "", ""]);
            // The other fields are read from other tables and do not depend on the names.
            expect(metadata.weight).to.equal(900);
        });
    }

    it("keeps the names found before the name records run past the end of the font", function () {
        // The count promises records past the end of the file, but the walk over them ends
        // earlier: where the string storage starts, which in the fixture is right after the twelve
        // real records. What was found by then stays — the English Windows names, the first source.
        const name = tableOffset(ttf, "name");

        expect(name + 6 + 0xffff * NAME_RECORD_SIZE, "records with a count of 0xffff fit into the font").to.be.greaterThan(ttf.length);
        expect(readMetadata(overcountNameRecords(ttf)).familyName).to.equal("Roboto Black");
    });

    // Only the current pass ends: the next source or language starts from record zero again. So
    // the names found by a later pass are read with an inflated count the same way as with the
    // right one.
    const laterPassCases: Array<[string, (bytes: Uint8Array) => Uint8Array]> = [
        ["only macintosh names", withoutWindowsNames],
        [
            "only non-english windows names",
            // The Macintosh records are hidden: their names match the Windows ones, and the text
            // would not show which pass read them.
            (bytes): Uint8Array =>
                patch(withoutNames(bytes, PLATFORM_MACINTOSH), (view, copy) => {
                    forEachNameRecord(copy, (record) => {
                        if (view.getUint16(record) === PLATFORM_WINDOWS) {
                            view.setUint16(record + 4, LANGUAGE_RUSSIAN);
                        }
                    });
                }),
        ],
    ];

    for (const [what, relabel] of laterPassCases) {
        it(`reads a font with ${what} when the name records run past the end of the font`, function () {
            const relabeled = relabel(ttf);

            expect(envelopeNames(overcountNameRecords(relabeled))).to.deep.equal(envelopeNames(relabeled));
            expect(envelopeNames(relabeled)).to.deep.equal(["Roboto Black", "Black", "Version 1.0", "Roboto-Black"]);
        });
    }

    it("stops the name records at the string storage", function () {
        // The fixture's string storage starts right after the last record, and an inflated count
        // would lead the walk on through the strings. At the start of the storage a Unicode
        // "record" for the family name is assembled, pointing at the Windows style string: the
        // Windows records are hidden, so nothing else reads their strings. Unicode is checked
        // before Macintosh, so the "record", once read, would shadow the real name.
        const disguised = patch(withoutWindowsNames(ttf), (view, copy) => {
            const name = tableOffset(copy, "name");
            const storage = name + view.getUint16(name + 4);
            const style = nameRecord(ttf, PLATFORM_WINDOWS, NAME_ID_STYLE);

            expect(storage, "the string storage does not start right after the records").to.equal(
                name + 6 + view.getUint16(name + 2) * NAME_RECORD_SIZE,
            );
            copy.set(ttf.subarray(style, style + NAME_RECORD_SIZE), storage);
            view.setUint16(storage, PLATFORM_UNICODE);
            view.setUint16(storage + 4, 0);
            view.setUint16(storage + 6, NAME_ID_FAMILY);
        });

        expect(readMetadata(overcountNameRecords(disguised)).familyName).to.equal("Roboto Black");
    });

    it("prefers the english name over one that stands earlier in the table", function () {
        // A font does not guarantee the order of its records, so the language matters more than
        // the position: ttf2eot, which the codec follows, looks for 0x0409 too. The existing
        // family name is declared Russian, and a later record is made the English one — its text
        // shows which of the two the codec chose.
        const englishLater = patch(ttf, (view, copy) => {
            const russian = nameRecord(copy, PLATFORM_WINDOWS, NAME_ID_FAMILY);
            const english = nameRecord(copy, PLATFORM_WINDOWS, NAME_ID_FULL);

            expect(russian, "the family name does not stand before the full name").to.be.lessThan(english);
            view.setUint16(russian + 4, LANGUAGE_RUSSIAN);
            view.setUint16(english + 6, NAME_ID_FAMILY);
        });

        expect(readMetadata(englishLater).familyName).to.equal("Roboto-Black");
    });

    it("reports no code page ranges for an os/2 table older than version 1", function () {
        const os2 = tableOffset(ttf, "OS/2");
        const metadata = readMetadata(patch(ttf, (view) => view.setUint16(os2, 0)));

        expect(metadata.codePageRange).to.deep.equal([0, 0]);
        // The rest lies before the code page ranges and is not cancelled by the version.
        expect(metadata.weight).to.equal(900);
    });

    it("reads a short os/2 table of version 0", function () {
        // The codec's fields end at fsSelection, so a 64-byte table is enough: in old Apple
        // fonts it is shorter than today's 78.
        const record = tableRecord(ttf, "OS/2");
        const shortened = patch(ttf, (view) => {
            view.setUint16(view.getUint32(record + 8), 0);
            view.setUint32(record + 12, 64);
        });

        expect(readMetadata(shortened).weight).to.equal(900);
    });

    it("reads an os/2 table that ends right at the end of the font", function () {
        // A table that is last in the file ends together with it. An OS/2 table of version 1 is
        // exactly the 86 bytes the codec reads, so its copy is moved to the end of the file.
        const record = tableRecord(ttf, "OS/2");
        const os2 = tableOffset(ttf, "OS/2");
        const moved = patch(Uint8Array.from(Buffer.concat([ttf, ttf.subarray(os2, os2 + 86)])), (view) => {
            view.setUint32(record + 8, ttf.length);
            view.setUint32(record + 12, 86);
        });

        expect(readMetadata(moved).codePageRange).to.deep.equal([0x2000_019f, 0]);
    });

    it("reads no more table records than the directory declares", function () {
        // The count ends right before the head record: the sixteen bytes after the directory are
        // no longer a record, and such a font has no head table. OS/2 comes earlier in the
        // directory, otherwise the rejection would come from it.
        const head = tableRecord(ttf, "head");
        const shortened = patch(ttf, (view) => view.setUint16(4, (head - TABLE_DIRECTORY_OFFSET) / TABLE_RECORD_SIZE));

        expect(tableRecord(ttf, "OS/2"), "OS/2 does not come before head in the directory").to.be.lessThan(head);
        expectThrows(() => readMetadata(shortened), InvalidSfnt);
    });

    it("rejects a file shorter than the sfnt header", function () {
        // The file breaks off inside the table count. At eight bytes the rejection would come
        // from parsing the directory too, while here without the length check a RangeError from
        // DataView would fly out.
        expectThrows(() => new SfntReader(ttf.subarray(0, 5)), InvalidSfnt);
    });

    it("rejects a container that is not sfnt", async function () {
        const woff = await readFixture(Extension.WOFF);

        expectThrows(() => new SfntReader(woff), InvalidSfnt);
    });

    it("rejects a font collection", function () {
        // "ttcf" is a legal sfnt, but it holds several fonts, and nothing says which of them to
        // put into the envelope.
        expectThrows(() => new SfntReader(patch(ttf, (view) => view.setUint32(0, 0x74746366))), InvalidSfnt);
    });

    it("rejects a table directory that does not fit into the font", function () {
        expectThrows(() => new SfntReader(patch(ttf, (view) => view.setUint16(4, 0xffff))), InvalidSfnt);
    });

    for (const tag of ["OS/2", "head"]) {
        it(`rejects a font without the ${tag} table`, function () {
            const record = tableRecord(ttf, tag);

            expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint32(record, 0x78787878))), InvalidSfnt);
        });

        it(`rejects a truncated ${tag} table`, function () {
            const record = tableRecord(ttf, tag);

            expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint32(record + 12, 4))), InvalidSfnt);
        });

        it(`rejects a ${tag} table that runs past the end of the font`, function () {
            // The table length is unchanged, but it starts four bytes before the end of the file:
            // without checking against the end of the file the fields would be read past the end
            // of the DataView.
            const record = tableRecord(ttf, tag);

            expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint32(record + 8, ttf.length - 4))), InvalidSfnt);
        });
    }

    it("rejects an os/2 table too short for the code page ranges it claims", function () {
        const record = tableRecord(ttf, "OS/2");

        expectThrows(() =>
            readMetadata(
                patch(ttf, (view) => {
                    // Version 1 promises code page ranges, and the table is too short for them.
                    view.setUint16(view.getUint32(record + 8), 1);
                    view.setUint32(record + 12, 78);
                }),
            ),
        );
    });

    function readMetadata(bytes: Uint8Array): ReturnType<SfntReader["readMetadata"]> {
        return new SfntReader(bytes).readMetadata();
    }

    function patch(bytes: Uint8Array, mutate: (view: DataView, copy: Uint8Array) => void): Uint8Array {
        const copy = Uint8Array.from(bytes);

        mutate(new DataView(copy.buffer), copy);

        return copy;
    }

    // The fixture duplicates its names on both platforms, so hiding the Windows records is enough
    // to reach the Macintosh ones.
    function withoutWindowsNames(bytes: Uint8Array): Uint8Array {
        return withoutNames(bytes, PLATFORM_WINDOWS);
    }

    // Records are hidden behind a platform ID that OpenType does not have, and the codec skips them.
    function withoutNames(bytes: Uint8Array, platformId: number): Uint8Array {
        return patch(bytes, (view, copy) => {
            forEachNameRecord(copy, (record) => {
                if (view.getUint16(record) === platformId) {
                    view.setUint16(record, PLATFORM_UNKNOWN);
                }
            });
        });
    }

    function overcountNameRecords(bytes: Uint8Array): Uint8Array {
        return patch(bytes, (view, copy) => view.setUint16(tableOffset(copy, "name") + 2, 0xffff));
    }

    // The table length is the last field of its directory record. The bytes of the table itself do not change.
    function withNameTableLength(bytes: Uint8Array, length: number): Uint8Array {
        return patch(bytes, (view, copy) => view.setUint32(tableRecord(copy, "name") + 12, length));
    }

    function envelopeNames(bytes: Uint8Array): Array<string> {
        const metadata = readMetadata(bytes);

        return [metadata.familyName, metadata.styleName, metadata.versionName, metadata.fullName];
    }

    function nameRecord(bytes: Uint8Array, platformId: number, nameId: number): number {
        const view = new DataView(bytes.buffer);
        let found: number | undefined;

        forEachNameRecord(bytes, (record) => {
            if (view.getUint16(record) === platformId && view.getUint16(record + 6) === nameId) {
                found ??= record;
            }
        });

        if (found === undefined) {
            throw new Error(`Fixture has no name ${nameId} for platform ${platformId}.`);
        }

        return found;
    }

    function windowsFamilyNameEnd(bytes: Uint8Array): number {
        const length = new DataView(bytes.buffer).getUint16(nameRecord(bytes, PLATFORM_WINDOWS, NAME_ID_FAMILY) + 8);

        return nameStringOffset(bytes, PLATFORM_WINDOWS, NAME_ID_FAMILY) + length;
    }

    function nameStringOffset(bytes: Uint8Array, platformId: number, nameId: number): number {
        const view = new DataView(bytes.buffer);
        const name = tableOffset(bytes, "name");

        return name + view.getUint16(name + 4) + view.getUint16(nameRecord(bytes, platformId, nameId) + 10);
    }

    function tableRecord(bytes: Uint8Array, tag: string): number {
        const view = new DataView(bytes.buffer);

        for (let index = 0; index < view.getUint16(4); index++) {
            const record = TABLE_DIRECTORY_OFFSET + index * TABLE_RECORD_SIZE;

            if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) {
                return record;
            }
        }

        throw new Error(`Fixture has no ${tag} table.`);
    }

    function tableOffset(bytes: Uint8Array, tag: string): number {
        return new DataView(bytes.buffer).getUint32(tableRecord(bytes, tag) + 8);
    }

    function forEachNameRecord(bytes: Uint8Array, visit: (record: number) => void): void {
        const name = tableOffset(bytes, "name");
        const recordCount = new DataView(bytes.buffer).getUint16(name + 2);

        for (let index = 0; index < recordCount; index++) {
            visit(name + 6 + index * NAME_RECORD_SIZE);
        }
    }

    function expectThrows(call: () => unknown, expected: new (...params: never) => Error = InvalidSfnt): void {
        try {
            call();
            expect.fail(`call did not throw ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);
        }
    }
});

describe("InvalidSfnt", function () {
    // The factories are checked directly: the specs above pin the class of the rejection, not the
    // text — which of the checks rejected the input is not a requirement
    // (docs/architecture/testing.md, "Working through survivors").
    // The version has leading zeros: the field is printed at full width.
    const cases = [
        {
            name: "InvalidSfnt.tooShort",
            error: InvalidSfnt.tooShort(5),
            message: "Sfnt font is too short: 5 bytes.",
            payload: { length: 5 },
        },
        {
            name: "InvalidSfnt.unknownVersion",
            error: InvalidSfnt.unknownVersion(0x00020000),
            message: "Unknown sfnt version: 0x00020000.",
            payload: { version: 0x00020000 },
        },
        {
            name: "InvalidSfnt.truncatedTable",
            error: InvalidSfnt.truncatedTable("glyf"),
            message: "Sfnt table glyf does not fit into the font.",
            payload: { tag: "glyf" },
        },
        {
            name: "InvalidSfnt.tableNotFound",
            error: InvalidSfnt.tableNotFound("OS/2"),
            message: "Sfnt table OS/2 not found.",
            payload: { tag: "OS/2" },
        },
    ];

    for (const { name, error, message, payload } of cases) {
        it(`${name} keeps its message and details`, function () {
            expect(error).to.be.instanceOf(InvalidSfnt);
            expect(error.message).to.equal(message);
            expect(error.payload).to.deep.equal(payload);
        });
    }
});

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
