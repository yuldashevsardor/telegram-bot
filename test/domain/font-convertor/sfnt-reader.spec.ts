import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { SfntReader } from "app/domain/font-convertor/eot-packer/sfnt-reader";
import { InvalidSfnt } from "app/domain/font-convertor/eot-packer/sfnt-reader.errors";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Смещения полей, которые правятся в фикстуре ради проверки отказов: в каталоге таблиц —
// тег, длина и смещение записи; в OS/2 — версия; в head — macStyle; в name — количество
// записей, а внутри записи — платформа и смещение строки.
const TABLE_DIRECTORY_OFFSET = 12;
const TABLE_RECORD_SIZE = 16;
const NAME_RECORD_SIZE = 12;
const PLATFORM_WINDOWS = 3;

describe("SfntReader.readMetadata", function () {
    let ttf: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
    });

    it("reads the fields the eot header duplicates", function () {
        const metadata = new SfntReader(ttf).readMetadata();

        expect({ ...metadata, panose: Array.from(metadata.panose) }).to.deep.equal({
            panose: [2, 0, 5, 3, 0, 0, 0, 0, 0, 0],
            italic: 0,
            weight: 400,
            fsType: 0,
            unicodeRange: [1, 0, 0, 0],
            codePageRange: [1, 0],
            checkSumAdjustment: 0x5d0efd61,
            familyName: "Signature Fixture",
            styleName: "Regular",
            versionName: "Version 001.000",
            fullName: "Signature Fixture",
        });
    });

    it("reads a font with cff outlines the same way", async function () {
        const metadata = new SfntReader(await readFixture(Extension.OTF)).readMetadata();

        expect(metadata.familyName).to.equal("Signature Fixture");
        expect(metadata.weight).to.equal(400);
        // Контрольная сумма своя: тот же глиф в другом контейнере — другой файл.
        expect(metadata.checkSumAdjustment).to.equal(0x98583c4c);
    });

    it("takes the italic flag from macStyle", function () {
        const head = tableOffset(ttf, "head");

        expect(readMetadata(patch(ttf, (view) => view.setUint16(head + 44, 0x0001))).italic).to.equal(1);
        // Второй бит macStyle — жирность, наклоном она не считается.
        expect(readMetadata(patch(ttf, (view) => view.setUint16(head + 44, 0x0002))).italic).to.equal(0);
    });

    it("falls back to the macintosh names when the font has no windows ones", function () {
        // У фикстуры имена продублированы обеими платформами, поэтому спрятать записи
        // Windows достаточно, чтобы проверить и приоритет платформ, и однобайтовое чтение.
        const hidden = patch(ttf, (view) => {
            forEachNameRecord(ttf, (record) => {
                if (view.getUint16(record) === PLATFORM_WINDOWS) {
                    view.setUint16(record, 0x0009);
                }
            });
        });

        expect(readMetadata(hidden).familyName).to.equal("Signature Fixture");
        expect(readMetadata(hidden).versionName).to.equal("Version 001.000");
    });

    it("reports no code page ranges for an os/2 table older than version 1", function () {
        const os2 = tableOffset(ttf, "OS/2");
        const metadata = readMetadata(patch(ttf, (view) => view.setUint16(os2, 0)));

        expect(metadata.codePageRange).to.deep.equal([0, 0]);
        // Остальное лежит до диапазонов кодировок и версией не отменяется.
        expect(metadata.weight).to.equal(400);
    });

    it("rejects a file shorter than the sfnt header", function () {
        expectThrows(() => new SfntReader(ttf.subarray(0, 8)), InvalidSfnt);
    });

    it("rejects a container that is not sfnt", async function () {
        const woff = await readFixture(Extension.WOFF);

        expectThrows(() => new SfntReader(woff), InvalidSfnt);
    });

    it("rejects a font collection", function () {
        // "ttcf" — законный sfnt, но в нём несколько шрифтов, и какой из них класть в
        // конверт, сказать нечем.
        expectThrows(() => new SfntReader(patch(ttf, (view) => view.setUint32(0, 0x74746366))), InvalidSfnt);
    });

    it("rejects a table directory that does not fit into the font", function () {
        expectThrows(() => new SfntReader(patch(ttf, (view) => view.setUint16(4, 0xffff))), InvalidSfnt);
    });

    for (const tag of ["OS/2", "head", "name"]) {
        it(`rejects a font without the ${tag} table`, function () {
            const record = tableRecord(ttf, tag);

            expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint32(record, 0x78787878))), InvalidSfnt);
        });

        it(`rejects a truncated ${tag} table`, function () {
            const record = tableRecord(ttf, tag);

            expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint32(record + 12, 4))), InvalidSfnt);
        });
    }

    it("rejects an os/2 table too short for the code page ranges it claims", function () {
        const record = tableRecord(ttf, "OS/2");

        expectThrows(() =>
            readMetadata(
                patch(ttf, (view) => {
                    // Версия 1 обещает диапазоны кодировок, а длины таблицы на них не хватает.
                    view.setUint16(view.getUint32(record + 8), 1);
                    view.setUint32(record + 12, 78);
                }),
            ),
        );
    });

    it("rejects a font without the name record the envelope needs", function () {
        const name = tableOffset(ttf, "name");

        expectThrows(() => readMetadata(patch(ttf, (view) => view.setUint16(name + 2, 0))), InvalidSfnt);
    });

    it("rejects a name string that runs past the end of the font", function () {
        expectThrows(() =>
            readMetadata(
                patch(ttf, (view) => {
                    forEachNameRecord(ttf, (record) => view.setUint16(record + 10, 0xffff));
                }),
            ),
        );
    });

    function readMetadata(bytes: Uint8Array): ReturnType<SfntReader["readMetadata"]> {
        return new SfntReader(bytes).readMetadata();
    }

    function patch(bytes: Uint8Array, mutate: (view: DataView) => void): Uint8Array {
        const copy = Uint8Array.from(bytes);

        mutate(new DataView(copy.buffer));

        return copy;
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

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `fixture.${extension}`)));
}
