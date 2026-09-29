import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import { InvalidSfnt } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.errors";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// The spec checks a record against the table it points to rather than against a second parse of
// the directory: head is 54 bytes long by the standard and carries a fixed magic number at 12.
const HEAD_LENGTH = 54;
const HEAD_MAGIC_NUMBER_OFFSET = 12;
const HEAD_MAGIC_NUMBER = 0x5f0f3cf5;
const COLLECTION_VERSION = 0x74746366;
const ENVELOPE_PREFIX_BYTES = 8;

describe("SfntTableDirectory", function () {
    let ttf: Uint8Array;
    let otf: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
        otf = await readFixture(Extension.OTF);
    });

    it("finds the head table where the record of a TrueType font points", function () {
        expectHeadRecord(ttf);
    });

    it("finds the head table where the record of a CFF font points", function () {
        expectHeadRecord(otf);
    });

    it("finds the outline tables the font has and no others", function () {
        const trueType = new SfntTableDirectory(ttf);
        const cff = new SfntTableDirectory(otf);

        expect(trueType.find("glyf"), "glyf in the TrueType font").to.not.equal(undefined);
        expect(trueType.find("CFF "), "CFF in the TrueType font").to.equal(undefined);
        expect(cff.find("CFF "), "CFF in the CFF font").to.not.equal(undefined);
        expect(cff.find("glyf"), "glyf in the CFF font").to.equal(undefined);
    });

    it("reads a font that lies inside a larger buffer", function () {
        // An EOT envelope hands its font over as a view into the envelope bytes, so the font does
        // not start at the beginning of its buffer.
        const envelope = Uint8Array.from(Buffer.concat([Buffer.alloc(ENVELOPE_PREFIX_BYTES), ttf]));

        expectHeadRecord(envelope.subarray(ENVELOPE_PREFIX_BYTES));
    });

    for (const version of SFNT_VERSIONS) {
        it(`accepts the sfnt version 0x${version.toString(16).padStart(8, "0")}`, function () {
            const directory = new SfntTableDirectory(patch(ttf, (view) => view.setUint32(0, version)));

            expect(directory.find("head")).to.not.equal(undefined);
        });
    }

    it("reads no more table records than the directory declares", function () {
        // post is the last record of the fixture. With the count one less, its sixteen bytes are
        // no longer a record, while the records before it still are.
        const fixtureTableCount = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength).getUint16(4);
        const directory = new SfntTableDirectory(patch(ttf, (view) => view.setUint16(4, fixtureTableCount - 1)));

        expect(directory.find("post"), "the record past the count").to.equal(undefined);
        expect(directory.find("name"), "the last record within the count").to.not.equal(undefined);
    });

    it("rejects a file shorter than the sfnt header", function () {
        // The file breaks off inside the table count. Without the length check DataView would
        // throw a RangeError.
        expectThrows(() => new SfntTableDirectory(ttf.subarray(0, 5)));
    });

    it("rejects a container that is not sfnt", async function () {
        const woff = await readFixture(Extension.WOFF);

        expectThrows(() => new SfntTableDirectory(woff));
    });

    it("rejects a font collection", function () {
        expectThrows(() => new SfntTableDirectory(patch(ttf, (view) => view.setUint32(0, COLLECTION_VERSION))));
    });

    it("rejects a table directory that does not fit into the file", function () {
        expectThrows(() => new SfntTableDirectory(patch(ttf, (view) => view.setUint16(4, 0xffff))));
    });

    function expectHeadRecord(bytes: Uint8Array): void {
        const head = new SfntTableDirectory(bytes).find("head");

        if (head === undefined) {
            expect.fail("head not found");
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        expect(head.length).to.equal(HEAD_LENGTH);
        expect(view.getUint32(head.offset + HEAD_MAGIC_NUMBER_OFFSET)).to.equal(HEAD_MAGIC_NUMBER);
    }

    function patch(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
        const copy = Uint8Array.from(bytes);

        mutate(new DataView(copy.buffer));

        return copy;
    }

    function expectThrows(call: () => unknown): void {
        expect(call).to.throw(InvalidSfnt);
    }
});

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
