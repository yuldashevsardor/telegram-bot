import { injectable } from "inversify";
import { FileHelper } from "app/helper/file-helper/file-helper";
import { InvalidEot, UnsupportedEotFlags } from "app/domain/font-convertor/eot-packer/eot-packer.errors";
import { SfntReader } from "app/domain/font-convertor/eot-packer/sfnt-reader";
import { SfntMetadata } from "app/domain/font-convertor/eot-packer/sfnt-reader.types";

// EOT — не самостоятельный формат обводок, а конверт: заголовок с метаданными и следом
// нетронутые байты sfnt. Поэтому пара с EOT идёт мимо движка: он этот конверт не читает,
// а на запись молча подсовывает PostScript Type 1
// (issue https://github.com/yuldashevsardor/telegram-bot/issues/158).
//
// Раскладка заголовка (все числа little-endian, в отличие от big-endian самого sfnt):
//   0  EOTSize            u32     размер всего файла
//   4  FontDataSize       u32     размер вложенного sfnt
//   8  Version            u32
//  12  Flags              u32
//  16  FontPANOSE         10 байт
//  26  Charset            u8
//  27  Italic             u8
//  28  Weight             u32
//  32  fsType             u16
//  34  MagicNumber        u16     0x504c
//  36  UnicodeRange1..4   4 × u32
//  52  CodePageRange1..2  2 × u32
//  60  CheckSumAdjustment u32
//  64  Reserved1..4       4 × u32
//  80  Padding1           u16
//  82  FamilyNameSize     u16, дальше имя в UTF-16LE без нуля на конце
//      Padding2 u16, StyleNameSize   u16, StyleName
//      Padding3 u16, VersionNameSize u16, VersionName
//      Padding4 u16, FullNameSize    u16, FullName
//      Padding5 u16, RootStringSize  u16, RootString   — с версии 0x00020001
//      FontData
const HEADER_FIXED_SIZE = 82;
const MAGIC_OFFSET = 34;
const MAGIC = 0x504c;

// Пишем 0x00020001: версия, которую понимают все читатели EOT, и та же, что у ttf2eot.
const VERSION_WRITTEN = 0x00020001;
const VERSION_1_0 = 0x00010000;
const VERSION_2_1 = 0x00020001;
const VERSION_2_2 = 0x00020002;
const VERSIONS_READ = [VERSION_1_0, VERSION_2_1, VERSION_2_2];

const CHARSET_DEFAULT = 0x01;

// TTEMBED_TTCOMPRESSED и TTEMBED_XORENCRYPTDATA: полезная нагрузка не сырой sfnt.
const FLAG_COMPRESSED = 0x00000004;
const FLAG_XOR_ENCRYPTED = 0x10000000;

const PANOSE_SIZE = 10;
const NAME_COUNT = 4;

@injectable()
export class EotPacker {
    /**
     * Кладёт sfnt в конверт EOT.
     */
    public async pack(sfntPath: string, eotPath: string): Promise<void> {
        const font = await FileHelper.read(sfntPath);
        const metadata = new SfntReader(font).readMetadata();

        await FileHelper.write(eotPath, this.buildEnvelope(font, metadata));
    }

    /**
     * Достаёт sfnt из конверта EOT.
     */
    public async unpack(eotPath: string, sfntPath: string): Promise<void> {
        const eot = await FileHelper.read(eotPath);
        const font = this.readFontData(eot);

        // Конверт мог оказаться складным: заголовок сходится, а внутри не шрифт.
        // Дальше файл уйдёт движку, поэтому проверяем здесь, а не там.
        SfntReader.validate(font);

        await FileHelper.write(sfntPath, font);
    }

    private buildEnvelope(font: Uint8Array, metadata: SfntMetadata): Uint8Array {
        const names = [metadata.familyName, metadata.styleName, metadata.versionName, metadata.fullName].map((name) =>
            this.encodeName(name),
        );
        // На каждое имя — свой размер (u16) и Padding следующего блока (u16); Padding1
        // уже входит в HEADER_FIXED_SIZE. Хвост — RootStringSize пустой строки: сама
        // строка не пишется, но поле в версии 0x00020001 обязательно.
        const namesSize = names.reduce((size, name) => size + 4 + name.length, 0);
        const headerSize = HEADER_FIXED_SIZE + namesSize + 2;

        const eot = new Uint8Array(headerSize + font.length);
        const view = new DataView(eot.buffer);

        view.setUint32(0, eot.length, true);
        view.setUint32(4, font.length, true);
        view.setUint32(8, VERSION_WRITTEN, true);
        view.setUint32(12, 0, true);
        eot.set(metadata.panose.subarray(0, PANOSE_SIZE), 16);
        view.setUint8(26, CHARSET_DEFAULT);
        view.setUint8(27, metadata.italic);
        view.setUint32(28, metadata.weight, true);
        view.setUint16(32, metadata.fsType, true);
        view.setUint16(MAGIC_OFFSET, MAGIC, true);

        for (let index = 0; index < 4; index++) {
            view.setUint32(36 + index * 4, metadata.unicodeRange[index] as number, true);
        }

        for (let index = 0; index < 2; index++) {
            view.setUint32(52 + index * 4, metadata.codePageRange[index] as number, true);
        }

        view.setUint32(60, metadata.checkSumAdjustment, true);

        let offset = HEADER_FIXED_SIZE;

        for (const name of names) {
            view.setUint16(offset, name.length, true);
            eot.set(name, offset + 2);
            // Следом за именем — Padding следующего блока, он уже занулён.
            offset += 2 + name.length + 2;
        }

        eot.set(font, headerSize);

        return eot;
    }

    private readFontData(eot: Uint8Array): Uint8Array {
        if (eot.length < HEADER_FIXED_SIZE) {
            throw InvalidEot.tooShort(eot.length);
        }

        const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength);
        const magic = view.getUint16(MAGIC_OFFSET, true);

        if (magic !== MAGIC) {
            throw InvalidEot.invalidMagic(magic);
        }

        const eotSize = view.getUint32(0, true);

        if (eotSize !== eot.length) {
            throw InvalidEot.sizeMismatch(eotSize, eot.length);
        }

        const version = view.getUint32(8, true);

        if (!VERSIONS_READ.includes(version)) {
            throw InvalidEot.unknownVersion(version);
        }

        const flags = view.getUint32(12, true);

        if ((flags & (FLAG_COMPRESSED | FLAG_XOR_ENCRYPTED)) !== 0) {
            throw UnsupportedEotFlags.byFlags(flags);
        }

        const fontDataSize = view.getUint32(4, true);

        if (fontDataSize === 0 || fontDataSize > eot.length - HEADER_FIXED_SIZE) {
            throw InvalidEot.invalidFontDataSize(fontDataSize, eot.length);
        }

        // Шрифт лежит в хвосте файла, поэтому его начало известно и без разбора
        // заголовка. Заголовок всё равно проходим целиком: сойдутся ли его переменные
        // блоки с этим началом — единственная проверка целостности конверта, которая у
        // нас есть.
        const fontDataOffset = eot.length - fontDataSize;
        const headerEnd = this.readHeaderEnd(eot, view, version);

        if (headerEnd > fontDataOffset) {
            throw InvalidEot.headerOverlapsFontData(headerEnd, fontDataOffset);
        }

        return eot.subarray(fontDataOffset);
    }

    /**
     * Смещение сразу за именами конверта: у версии 1.0 их четыре, дальше добавляется
     * RootString. Хвост версии 0x00020002 не разбирается — он лежит между заголовком и
     * шрифтом и в проверку не входит.
     */
    private readHeaderEnd(eot: Uint8Array, view: DataView, version: number): number {
        // Цикл ждёт Padding в начале блока, а Padding1 уже входит в HEADER_FIXED_SIZE.
        let offset = HEADER_FIXED_SIZE - 2;
        const blockCount = version === VERSION_1_0 ? NAME_COUNT : NAME_COUNT + 1;

        for (let index = 0; index < blockCount; index++) {
            // Padding, размер блока, сам блок.
            offset += 2;

            if (offset + 2 > eot.length) {
                throw InvalidEot.tooShort(eot.length);
            }

            offset += 2 + view.getUint16(offset, true);
        }

        return offset;
    }

    private encodeName(name: string): Uint8Array {
        const bytes = new Uint8Array(name.length * 2);
        const view = new DataView(bytes.buffer);

        for (let index = 0; index < name.length; index++) {
            view.setUint16(index * 2, name.charCodeAt(index), true);
        }

        return bytes;
    }
}
