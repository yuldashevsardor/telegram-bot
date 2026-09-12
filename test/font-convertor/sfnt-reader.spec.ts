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
const PLATFORM_MACINTOSH = 1;
const PLATFORM_WINDOWS = 3;
const NAME_ID_FAMILY = 1;
const NAME_ID_FULL = 4;
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
        // Контрольная сумма своя: тот же шрифт в другом контейнере — другой файл.
        expect(metadata.checkSumAdjustment).to.equal(0xf111_6829);
    });

    it("takes the italic flag from the os/2 table", function () {
        const os2 = tableOffset(ttf, "OS/2");
        const head = tableOffset(ttf, "head");

        expect(readMetadata(patch(ttf, (view) => view.setUint16(os2 + 62, 0x0001))).italic).to.equal(1);
        // Бит 5 fsSelection — жирность, наклоном она не считается.
        expect(readMetadata(patch(ttf, (view) => view.setUint16(os2 + 62, 0x0020))).italic).to.equal(0);
        // head.macStyle наклон дублирует, но читается не он: там наклон в бите 1, а в
        // бите 0 жирность, и перепутать их — объявить наклонный шрифт прямым.
        expect(readMetadata(patch(ttf, (view) => view.setUint16(head + 44, 0x0002))).italic).to.equal(0);
    });

    it("falls back to the macintosh names when the font has no windows ones", function () {
        expect(readMetadata(withoutWindowsNames(ttf)).familyName).to.equal("Roboto Black");
        expect(readMetadata(withoutWindowsNames(ttf)).versionName).to.equal("Version 1.0");
    });

    it("decodes the macintosh names as macroman, not latin-1", function () {
        // 0x8e — «é» в MacRoman и «Ž» в Latin-1: байт, на котором кодировки расходятся.
        const renamed = patch(withoutWindowsNames(ttf), (_view, bytes) => {
            bytes[nameStringOffset(bytes, PLATFORM_MACINTOSH, NAME_ID_FAMILY)] = 0x8e;
        });

        expect(readMetadata(renamed).familyName).to.equal("éoboto Black");
    });

    // Записи name режут субсеттеры, а таблицу целиком снимает
    // `pyftsubset --drop-tables+=name`; поля конверта при этом информационные, и отвергать
    // из-за них шрифт целиком дороже, чем отдать пустую строку.
    const namelessCases: Array<[string, (bytes: Uint8Array) => Uint8Array]> = [
        ["carries no name records", (bytes): Uint8Array => patch(bytes, (view, copy) => view.setUint16(tableOffset(copy, "name") + 2, 0))],
        [
            "carries no name table",
            (bytes): Uint8Array => patch(bytes, (view, copy) => view.setUint32(tableRecord(copy, "name"), 0x78787878)),
        ],
        [
            "has a truncated name table",
            (bytes): Uint8Array => patch(bytes, (view, copy) => view.setUint32(tableRecord(copy, "name") + 12, 4)),
        ],
        [
            "points its names past the end of the font",
            (bytes): Uint8Array =>
                patch(bytes, (view, copy) => {
                    forEachNameRecord(copy, (record): void => view.setUint16(record + 10, 0xffff));
                }),
        ],
    ];

    for (const [what, damage] of namelessCases) {
        it(`leaves the envelope names empty when the font ${what}`, function () {
            const metadata = readMetadata(damage(ttf));

            expect([metadata.familyName, metadata.styleName, metadata.versionName, metadata.fullName]).to.deep.equal(["", "", "", ""]);
            // Остальные поля читаются из других таблиц и от имён не зависят.
            expect(metadata.weight).to.equal(900);
        });
    }

    it("prefers the english name over one that stands earlier in the table", function () {
        // Порядок записей шрифт не гарантирует, поэтому язык важнее места: ttf2eot, на
        // который равняется кодек, тоже ищет 0x0409. Имеющееся имя семейства объявляем
        // русским, а английским делаем запись, стоящую позже, — по её тексту и видно,
        // какую из двух выбрал кодек.
        const englishLater = patch(ttf, (view, copy) => {
            const russian = nameRecord(copy, PLATFORM_WINDOWS, NAME_ID_FAMILY);
            const english = nameRecord(copy, PLATFORM_WINDOWS, NAME_ID_FULL);

            expect(russian, "имя семейства стоит не раньше полного имени").to.be.lessThan(english);
            view.setUint16(russian + 4, LANGUAGE_RUSSIAN);
            view.setUint16(english + 6, NAME_ID_FAMILY);
        });

        expect(readMetadata(englishLater).familyName).to.equal("Roboto-Black");
    });

    it("reports no code page ranges for an os/2 table older than version 1", function () {
        const os2 = tableOffset(ttf, "OS/2");
        const metadata = readMetadata(patch(ttf, (view) => view.setUint16(os2, 0)));

        expect(metadata.codePageRange).to.deep.equal([0, 0]);
        // Остальное лежит до диапазонов кодировок и версией не отменяется.
        expect(metadata.weight).to.equal(900);
    });

    it("reads a short os/2 table of version 0", function () {
        // Поля кодека кончаются на fsSelection, поэтому таблицы в 64 байта хватает:
        // у старых шрифтов Apple она короче нынешних 78.
        const record = tableRecord(ttf, "OS/2");
        const shortened = patch(ttf, (view) => {
            view.setUint16(view.getUint32(record + 8), 0);
            view.setUint32(record + 12, 64);
        });

        expect(readMetadata(shortened).weight).to.equal(900);
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

    for (const tag of ["OS/2", "head"]) {
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

    function readMetadata(bytes: Uint8Array): ReturnType<SfntReader["readMetadata"]> {
        return new SfntReader(bytes).readMetadata();
    }

    function patch(bytes: Uint8Array, mutate: (view: DataView, copy: Uint8Array) => void): Uint8Array {
        const copy = Uint8Array.from(bytes);

        mutate(new DataView(copy.buffer), copy);

        return copy;
    }

    // У фикстуры имена продублированы обеими платформами, поэтому спрятать записи Windows
    // достаточно, чтобы дойти до записей Macintosh.
    function withoutWindowsNames(bytes: Uint8Array): Uint8Array {
        return patch(bytes, (view, copy) => {
            forEachNameRecord(copy, (record) => {
                if (view.getUint16(record) === PLATFORM_WINDOWS) {
                    view.setUint16(record, 0x0009);
                }
            });
        });
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

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
