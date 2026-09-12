import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { InvalidEot, UnsupportedEotFlags } from "app/font-convertor/eot-packer/eot-packer.errors";
import { InvalidSfnt } from "app/font-convertor/eot-packer/sfnt-reader.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/font-convertor/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

// Поля заголовка EOT, которые спека читает по отдельности.
const EOT_ITALIC_OFFSET = 27;
const EOT_FS_TYPE_OFFSET = 32;
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

        it("rejects a font without the eot magic number", async function () {
            await expectRejects(() => unpack(ttf), InvalidEot);
        });

        it("rejects an envelope whose declared size does not match the file", async function () {
            await expectRejects(() => unpack(eot.subarray(0, eot.length - 1)), InvalidEot);
        });

        it("rejects an envelope with compressed font data", async function () {
            const compressed = Uint8Array.from(eot);
            // TTEMBED_TTCOMPRESSED во Flags: полезная нагрузка перестаёт быть сырым sfnt.
            new DataView(compressed.buffer).setUint32(12, 0x00000004, true);

            await expectRejects(() => unpack(compressed), UnsupportedEotFlags);
        });

        it("rejects an envelope whose name blocks run past the font data", async function () {
            const shifted = Uint8Array.from(eot);
            // Раздутое имя семейства съедает начало шрифта — так выглядит конверт,
            // собранный с ошибкой в раскладке заголовка.
            new DataView(shifted.buffer).setUint16(82, 0x0400, true);

            await expectRejects(() => unpack(shifted), InvalidEot);
        });

        it("rejects an envelope that does not hold a font", async function () {
            const stuffed = Uint8Array.from(eot);
            new DataView(stuffed.buffer).setUint32(stuffed.length - ttf.length, 0xdeadbeef);

            await expectRejects(() => unpack(stuffed), InvalidSfnt);
        });
    });

    async function expectRejects(call: () => Promise<unknown>, expected: new (...params: never) => Error): Promise<void> {
        try {
            await call();
            expect.fail(`call did not throw ${expected.name}`);
        } catch (error) {
            expect(error).to.be.instanceOf(expected);
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
