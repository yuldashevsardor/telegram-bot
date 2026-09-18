import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { InvalidEot, UnsupportedEotFlags } from "app/font-convertor/eot-packer/eot-packer.errors";
import { InvalidSfnt } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Поля заголовка EOT, которые спека читает и правит по отдельности, и длина его
// фиксированной части — до FamilyNameSize.
const EOT_SIZE_OFFSET = 0;
const EOT_FONT_DATA_SIZE_OFFSET = 4;
const EOT_VERSION_OFFSET = 8;
const EOT_FLAGS_OFFSET = 12;
const EOT_ITALIC_OFFSET = 27;
const EOT_FS_TYPE_OFFSET = 32;
const EOT_MAGIC_OFFSET = 34;
const EOT_UNICODE_RANGE_OFFSET = 36;
const EOT_HEADER_FIXED_SIZE = 82;
const eotPacker = new EotPacker();

describe("EotPacker", function () {
    let workDir: string;
    let ttf: Uint8Array;
    let eot: Uint8Array;

    before(async function () {
        ttf = await readFixture(Extension.TTF);
        eot = await readFixture(Extension.EOT);
    });

    beforeEach(async function () {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eot-packer-"));
    });

    afterEach(async function () {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    describe("pack", function () {
        it("wraps the font into the envelope ttf2eot produces for it", async function () {
            // Фикстура EOT сделана сторонним ttf2eot из фикстуры TTF, поэтому побайтовое
            // совпадение с ней — проверка на соответствие формату, а не самим себе.
            //
            // Расходимся с ttf2eot ровно в одном поле: fsType он всегда пишет нулём, то
            // есть объявляет любой шрифт свободным для установки. По спецификации это
            // поле повторяет OS/2.fsType, откуда мы его и берём, поэтому эталон
            // сравнивается с подставленным настоящим значением.
            const expected = Uint8Array.from(eot);
            new DataView(expected.buffer).setUint16(EOT_FS_TYPE_OFFSET, fontFsType(ttf), true);

            expect(hex(await pack(ttf))).to.equal(hex(expected));
        });

        it("carries the embedding permissions of the font into the envelope", async function () {
            // fsType по смещению 32 — то, что читатель EOT спросит, прежде чем ставить
            // шрифт: у Roboto-Black там 8, «встраивать можно, устанавливать нельзя».
            const packed = await pack(ttf);

            expect(new DataView(packed.buffer, packed.byteOffset).getUint16(EOT_FS_TYPE_OFFSET, true)).to.equal(fontFsType(ttf));
            expect(fontFsType(ttf)).to.equal(8);
        });

        it("produces a file the signature matcher accepts as eot", async function () {
            const packed = await pack(ttf);

            expect(new FontSignatureMatcher().matches(packed, Extension.EOT)).to.be.true;
        });

        it("carries the italic flag of the font into the envelope", async function () {
            // Наклон — одно из полей, ради которых конверт вообще читает шрифт; байт
            // Italic лежит в заголовке по смещению 27.
            const italic = Uint8Array.from(ttf);
            new DataView(italic.buffer).setUint16(os2Offset(ttf) + 62, 0x0001);

            expect((await pack(ttf))[EOT_ITALIC_OFFSET]).to.equal(0);
            expect((await pack(italic))[EOT_ITALIC_OFFSET]).to.equal(1);
        });

        it("puts each unicode and code page range into its own place in the header", async function () {
            // У фикстуры UnicodeRange4 и CodePageRange2 нулевые, и сравнение с ttf2eot не
            // заметило бы диапазон, записанный не на своё место: ноль лёг бы на ноль. В OS/2
            // диапазоны лежат двумя кусками, в заголовке EOT — подряд.
            const ranges = [0x0102_0304, 0x0506_0708, 0x090a_0b0c, 0x0d0e_0f10, 0x1112_1314, 0x1516_1718];
            const font = Uint8Array.from(ttf);
            const view = new DataView(font.buffer);
            ranges.slice(0, 4).forEach((range, index) => view.setUint32(os2Offset(ttf) + 42 + index * 4, range));
            ranges.slice(4).forEach((range, index) => view.setUint32(os2Offset(ttf) + 78 + index * 4, range));

            const packed = new DataView((await pack(font)).buffer);

            expect(ranges.map((_range, index) => packed.getUint32(EOT_UNICODE_RANGE_OFFSET + index * 4, true))).to.deep.equal(ranges);
        });

        it("leaves the font data untouched", async function () {
            const packed = await pack(ttf);

            expect(hex(packed.subarray(packed.length - ttf.length))).to.equal(hex(ttf));
        });

        it("rejects a file that is not sfnt", async function () {
            const svg = await readFixture(Extension.SVG);

            await expectRejects(() => pack(svg), InvalidSfnt);
        });
    });

    describe("unpack", function () {
        it("returns the font the envelope was made of", async function () {
            const unpacked = await unpack(eot);

            expect(hex(unpacked)).to.equal(hex(ttf));
        });

        it("undoes pack for every supported sfnt fixture", async function () {
            for (const extension of [Extension.TTF, Extension.OTF]) {
                const font = await readFixture(extension);

                expect(hex(await unpack(await pack(font))), extension).to.equal(hex(font));
            }
        });

        it("returns the font of a version 1.0 envelope, which has no root string", async function () {
            // У версии 1.0 заголовок кончается полным именем: блока RootString (Padding5 и
            // RootStringSize, у фикстуры строка пустая) нет, и шрифт идёт сразу за именами.
            // Прочитанный как 0x00020001, такой конверт залез бы пятым блоком в шрифт.
            const rootStringStart = eot.length - ttf.length - 4;
            const legacy = Uint8Array.from(Buffer.concat([eot.subarray(0, rootStringStart), ttf]));
            const view = new DataView(legacy.buffer);
            view.setUint32(EOT_SIZE_OFFSET, legacy.length, true);
            view.setUint32(EOT_VERSION_OFFSET, 0x00010000, true);

            expect(hex(await unpack(legacy))).to.equal(hex(ttf));
        });

        it("rejects an envelope without the eot magic number", async function () {
            // Остальной заголовок цел: без проверки маркера такой конверт распаковался бы.
            const unmarked = Uint8Array.from(eot);
            new DataView(unmarked.buffer).setUint16(EOT_MAGIC_OFFSET, 0, true);

            await expectRejects(() => unpack(unmarked), InvalidEot);
        });

        it("rejects a file cut off inside the fixed part of the header", async function () {
            // Обрубок не дотягивает даже до маркера формата по смещению 34: без проверки
            // длины вместо InvalidEot вылетел бы RangeError из DataView.
            await expectRejects(() => unpack(eot.subarray(0, 20)), InvalidEot);
        });

        it("rejects an envelope whose declared size does not match the file", async function () {
            // Размер правится в заголовке, а файл остаётся целым. Обрезанный файл проверку не
            // держит: у него сдвигается и начало шрифта, и отказ пришёл бы от сверки имён с ним.
            const misdeclared = Uint8Array.from(eot);
            new DataView(misdeclared.buffer).setUint32(EOT_SIZE_OFFSET, eot.length + 1, true);

            await expectRejects(() => unpack(misdeclared), InvalidEot);
        });

        it("rejects an envelope of an unknown version", async function () {
            const unknown = Uint8Array.from(eot);
            new DataView(unknown.buffer).setUint32(EOT_VERSION_OFFSET, 0x00030000, true);

            await expectRejects(() => unpack(unknown), InvalidEot);
        });

        it("rejects an envelope with compressed font data", async function () {
            const compressed = Uint8Array.from(eot);
            // TTEMBED_TTCOMPRESSED во Flags: полезная нагрузка перестаёт быть сырым sfnt.
            new DataView(compressed.buffer).setUint32(EOT_FLAGS_OFFSET, 0x00000004, true);

            await expectRejects(() => unpack(compressed), UnsupportedEotFlags);
        });

        it("rejects an envelope that declares no font data", async function () {
            const empty = Uint8Array.from(eot);
            new DataView(empty.buffer).setUint32(EOT_FONT_DATA_SIZE_OFFSET, 0, true);

            await expectRejects(() => unpack(empty), InvalidEot);
        });

        it("rejects an envelope whose font data does not fit behind the fixed part of the header", async function () {
            // Шрифт на байт длиннее места за фиксированной частью. Сверяется payload, а не
            // только класс: такое начало шрифта отвергла бы и проверка перекрытия с именами,
            // тоже InvalidEot, но со своим payload.
            const oversized = Uint8Array.from(eot);
            const fontDataSize = oversized.length - EOT_HEADER_FIXED_SIZE + 1;
            new DataView(oversized.buffer).setUint32(EOT_FONT_DATA_SIZE_OFFSET, fontDataSize, true);

            const error = await expectRejects(() => unpack(oversized), InvalidEot);

            expect(error.payload).to.deep.equal({ fontDataSize: fontDataSize, length: oversized.length });
        });

        it("rejects an envelope whose name blocks run past the font data", async function () {
            const shifted = Uint8Array.from(eot);
            // Раздутое имя семейства съедает начало шрифта — так выглядит конверт,
            // собранный с ошибкой в раскладке заголовка.
            new DataView(shifted.buffer).setUint16(EOT_HEADER_FIXED_SIZE, 0x0400, true);

            await expectRejects(() => unpack(shifted), InvalidEot);
        });

        it("rejects an envelope whose root string runs past the font data", async function () {
            // С версии 0x00020001 за именами идёт пятый блок, RootString, и с началом шрифта
            // он сверяется так же. У фикстуры строка пустая, и её размер — последние два байта
            // перед шрифтом.
            const rooted = Uint8Array.from(eot);
            new DataView(rooted.buffer).setUint16(eot.length - ttf.length - 2, 0x0400, true);

            await expectRejects(() => unpack(rooted), InvalidEot);
        });

        it("rejects an envelope that ends inside a name size", async function () {
            // Размеры в заголовке с длиной файла сходятся — шрифту отведены четыре байта, —
            // но файл обрывается на первом байте StyleNameSize. Это уже не наезд на шрифт, а
            // чтение за концом буфера: без своей проверки вылетел бы RangeError из DataView.
            // Обрыв приходится на сам размер, а не на имя за ним: иначе проверку, сдвинутую
            // на пару байт, тест не отличил бы.
            const familyNameSize = new DataView(eot.buffer).getUint16(EOT_HEADER_FIXED_SIZE, true);
            const cut = Uint8Array.from(eot.subarray(0, EOT_HEADER_FIXED_SIZE + 2 + familyNameSize + 2 + 1));
            const view = new DataView(cut.buffer);
            view.setUint32(EOT_SIZE_OFFSET, cut.length, true);
            view.setUint32(EOT_FONT_DATA_SIZE_OFFSET, 4, true);

            await expectRejects(() => unpack(cut), InvalidEot);
        });

        it("rejects an envelope that does not hold a font", async function () {
            const stuffed = Uint8Array.from(eot);
            new DataView(stuffed.buffer).setUint32(stuffed.length - ttf.length, 0xdeadbeef);

            await expectRejects(() => unpack(stuffed), InvalidSfnt);
        });
    });

    async function expectRejects<T extends Error>(call: () => Promise<unknown>, expected: new (...params: never) => T): Promise<T> {
        try {
            await call();
            expect.fail(`call did not throw ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);

            return error as T;
        }
    }

    async function pack(font: Uint8Array): Promise<Uint8Array> {
        const fontPath = path.join(workDir, `source.${Extension.TTF}`);
        const eotPath = path.join(workDir, `packed.${Extension.EOT}`);

        await fs.writeFile(fontPath, font);
        await eotPacker.pack(fontPath, eotPath);

        return Uint8Array.from(await fs.readFile(eotPath));
    }

    async function unpack(envelope: Uint8Array): Promise<Uint8Array> {
        const eotPath = path.join(workDir, `source.${Extension.EOT}`);
        const fontPath = path.join(workDir, `unpacked.${Extension.TTF}`);

        await fs.writeFile(eotPath, envelope);
        await eotPacker.unpack(eotPath, fontPath);

        return Uint8Array.from(await fs.readFile(fontPath));
    }
});

describe("InvalidEot and UnsupportedEotFlags", function () {
    // Фабрики проверяются напрямую: спеки unpack() выше держат класс отказа, а не текст — какая
    // из проверок отвергла вход, не требование (docs/architecture/testing.md, «Разбор
    // выживших»). Шестнадцатеричные значения взяты с ведущими нулями: поле печатается во всю
    // ширину.
    const cases = [
        {
            name: "InvalidEot.tooShort",
            error: InvalidEot.tooShort(20),
            type: InvalidEot,
            message: "Eot font is too short: 20 bytes.",
            payload: { length: 20 },
        },
        {
            name: "InvalidEot.invalidMagic",
            error: InvalidEot.invalidMagic(0x4c),
            type: InvalidEot,
            message: "Eot magic number is 0x004c, expected 0x504c.",
            payload: { magic: 0x4c },
        },
        {
            name: "InvalidEot.unknownVersion",
            error: InvalidEot.unknownVersion(0x00030000),
            type: InvalidEot,
            message: "Unknown eot version: 0x00030000.",
            payload: { version: 0x00030000 },
        },
        {
            name: "InvalidEot.sizeMismatch",
            error: InvalidEot.sizeMismatch(1025, 1024),
            type: InvalidEot,
            message: "Eot declares 1025 bytes, file has 1024.",
            payload: { declared: 1025, actual: 1024 },
        },
        {
            name: "InvalidEot.invalidFontDataSize",
            error: InvalidEot.invalidFontDataSize(0, 1024),
            type: InvalidEot,
            message: "Eot declares 0 bytes of font data, which does not fit into 1024 bytes.",
            payload: { fontDataSize: 0, length: 1024 },
        },
        {
            name: "InvalidEot.headerOverlapsFontData",
            error: InvalidEot.headerOverlapsFontData(1200, 1100),
            type: InvalidEot,
            message: "Eot header ends at 1200, past the font data start at 1100.",
            payload: { headerEnd: 1200, fontDataOffset: 1100 },
        },
        {
            name: "UnsupportedEotFlags.byFlags",
            error: UnsupportedEotFlags.byFlags(0x00000004),
            type: UnsupportedEotFlags,
            message: "Eot font data is compressed or encrypted: flags 0x00000004.",
            payload: { flags: 0x00000004 },
        },
    ];

    for (const { name, error, type, message, payload } of cases) {
        it(`${name} keeps its message and details`, function () {
            expect(error).to.be.instanceOf(type);
            expect(error.message).to.equal(message);
            expect(error.payload).to.deep.equal(payload);
        });
    }
});

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

function os2Offset(bytes: Uint8Array): number {
    return new DataView(bytes.buffer).getUint32(tableRecord(bytes, "OS/2") + 8);
}

/**
 * fsType шрифта: в OS/2 он лежит по смещению 8.
 */
function fontFsType(bytes: Uint8Array): number {
    return new DataView(bytes.buffer).getUint16(os2Offset(bytes) + 8);
}

/**
 * Смещение записи таблицы в каталоге sfnt: заголовок 12 байт, записи по 16.
 */
function tableRecord(bytes: Uint8Array, tag: string): number {
    const view = new DataView(bytes.buffer);

    for (let index = 0; index < view.getUint16(4); index++) {
        const record = 12 + index * 16;

        if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) {
            return record;
        }
    }

    throw new Error(`Fixture has no ${tag} table.`);
}

async function readFixture(extension: Extension): Promise<Uint8Array> {
    return Uint8Array.from(await fs.readFile(path.join(fixtureDir, `test-font.${extension}`)));
}
