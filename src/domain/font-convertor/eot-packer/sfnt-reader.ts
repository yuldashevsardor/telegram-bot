import { InvalidSfnt } from "app/domain/font-convertor/eot-packer/sfnt-reader.errors";
import { SfntMetadata } from "app/domain/font-convertor/eot-packer/sfnt-reader.types";

type TableRecord = {
    offset: number;
    length: number;
};

const SFNT_HEADER_SIZE = 12;
const TABLE_RECORD_SIZE = 16;

// Версии sfnt, которые несут ровно один шрифт: TrueType-обводки, их старый
// макинтошевский вариант ("true") и CFF ("OTTO"). Коллекция ("ttcf") сюда не подходит —
// в конверт EOT кладётся один шрифт, а какой из коллекции, сказать нечем.
const SFNT_VERSIONS = [0x00010000, 0x74727565, 0x4f54544f];

const NAME_ID_FAMILY = 1;
const NAME_ID_STYLE = 2;
const NAME_ID_FULL = 4;
const NAME_ID_VERSION = 5;

// Платформы таблицы name: у Windows и Unicode строки в UTF-16BE, у Macintosh —
// однобайтовые. Windows идёт первой: её записи есть почти во всех шрифтах и именно
// их ждёт от EOT читатель на Windows.
const PLATFORM_UNICODE = 0;
const PLATFORM_MACINTOSH = 1;
const PLATFORM_WINDOWS = 3;
const NAME_PLATFORM_PRIORITY = [PLATFORM_WINDOWS, PLATFORM_UNICODE, PLATFORM_MACINTOSH];

export class SfntReader {
    private readonly view: DataView;
    private readonly tables = new Map<string, TableRecord>();

    public constructor(private readonly bytes: Uint8Array) {
        if (bytes.length < SFNT_HEADER_SIZE) {
            throw InvalidSfnt.tooShort(bytes.length);
        }

        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        const version = this.view.getUint32(0);

        if (!SFNT_VERSIONS.includes(version)) {
            throw InvalidSfnt.unknownVersion(version);
        }

        const tableCount = this.view.getUint16(4);

        for (let index = 0; index < tableCount; index++) {
            const record = SFNT_HEADER_SIZE + index * TABLE_RECORD_SIZE;

            if (record + TABLE_RECORD_SIZE > bytes.length) {
                throw InvalidSfnt.tooShort(bytes.length);
            }

            const tag = String.fromCharCode(...bytes.subarray(record, record + 4));

            this.tables.set(tag, {
                offset: this.view.getUint32(record + 8),
                length: this.view.getUint32(record + 12),
            });
        }
    }

    public readMetadata(): SfntMetadata {
        // Смещения полей внутри таблиц: OS/2 — usWeightClass 4, fsType 8, panose 32,
        // ulUnicodeRange1..4 42, fsSelection 62, ulCodePageRange1..2 78 (с версии 1);
        // head — checkSumAdjustment 8, macStyle 44.
        const os2 = this.table("OS/2", 78);
        const os2Version = this.view.getUint16(os2);
        const codePageRangeOffset = 78;
        const hasCodePageRange = os2Version >= 1;

        if (hasCodePageRange) {
            this.table("OS/2", codePageRangeOffset + 8);
        }

        const head = this.table("head", 46);

        return {
            panose: this.bytes.slice(os2 + 32, os2 + 42),
            italic: this.view.getUint16(head + 44) & 0x0001,
            weight: this.view.getUint16(os2 + 4),
            fsType: this.view.getUint16(os2 + 8),
            unicodeRange: [0, 1, 2, 3].map((index) => this.view.getUint32(os2 + 42 + index * 4)),
            codePageRange: hasCodePageRange ? [0, 1].map((index) => this.view.getUint32(os2 + codePageRangeOffset + index * 4)) : [0, 0],
            checkSumAdjustment: this.view.getUint32(head + 8),
            familyName: this.readName(NAME_ID_FAMILY),
            styleName: this.readName(NAME_ID_STYLE),
            versionName: this.readName(NAME_ID_VERSION),
            fullName: this.readName(NAME_ID_FULL),
        };
    }

    private table(tag: string, minLength: number): number {
        const record = this.tables.get(tag);

        if (record === undefined) {
            throw InvalidSfnt.tableNotFound(tag);
        }

        if (record.length < minLength || record.offset + minLength > this.bytes.length) {
            throw InvalidSfnt.truncatedTable(tag);
        }

        return record.offset;
    }

    private readName(nameId: number): string {
        // Формат таблицы name: count 2, storageOffset 4, дальше записи по 12 байт —
        // platformId 0, encodingId 2, languageId 4, nameId 6, length 8, stringOffset 10.
        const name = this.table("name", 6);
        const recordCount = this.view.getUint16(name + 2);
        const storage = name + this.view.getUint16(name + 4);

        this.table("name", 6 + recordCount * 12);

        for (const platformId of NAME_PLATFORM_PRIORITY) {
            for (let index = 0; index < recordCount; index++) {
                const record = name + 6 + index * 12;

                if (this.view.getUint16(record) !== platformId || this.view.getUint16(record + 6) !== nameId) {
                    continue;
                }

                const length = this.view.getUint16(record + 8);
                const offset = storage + this.view.getUint16(record + 10);

                if (offset + length > this.bytes.length) {
                    throw InvalidSfnt.truncatedTable("name");
                }

                return this.decodeName(this.bytes.subarray(offset, offset + length), platformId);
            }
        }

        throw InvalidSfnt.nameNotFound(nameId);
    }

    private decodeName(bytes: Uint8Array, platformId: number): string {
        if (platformId === PLATFORM_MACINTOSH) {
            return String.fromCharCode(...bytes);
        }

        let text = "";

        for (let index = 0; index + 1 < bytes.length; index += 2) {
            text += String.fromCharCode(((bytes[index] as number) << 8) | (bytes[index + 1] as number));
        }

        return text;
    }
}
