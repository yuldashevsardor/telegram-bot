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
//
// Сигнатура на входе (`FontSignatureMatcher`) эту проверку не заменяет: она смотрит
// только исходник под его собственным расширением, а сюда приходят ещё два файла,
// которых она не видела, — промежуточный sfnt от движка на упаковке и содержимое
// конверта на распаковке.
const SFNT_VERSIONS = [0x00010000, 0x74727565, 0x4f54544f];

// Поля, которые кодек читает из OS/2, кончаются на fsSelection (62), поэтому версии 0
// хватает 64 байт: у старых шрифтов таблица бывает короче нынешних 78.
const OS2_VERSION_0_SIZE = 64;
// Диапазоны кодировок появляются с версии 1 и лежат сразу за таблицей версии 0.
const OS2_CODE_PAGE_RANGE_OFFSET = 78;
// fsSelection бит 0 — наклон. head.macStyle его дублирует (бит 1, а не 0: нулевой бит там
// жирность), но канон для OpenType — OS/2, и наклон из него же берёт ttf2eot.
const OS2_FS_SELECTION_ITALIC = 0x0001;

// head читается только ради checkSumAdjustment по смещению 8.
const HEAD_MIN_SIZE = 12;

const NAME_HEADER_SIZE = 6;
const NAME_RECORD_SIZE = 12;
const NAME_ID_FAMILY = 1;
const NAME_ID_STYLE = 2;
const NAME_ID_FULL = 4;
const NAME_ID_VERSION = 5;

// Платформы таблицы name с кодировкой, которую кодек умеет прочитать: у Windows и Unicode
// строки в UTF-16BE, у Macintosh однобайтовым MacRoman закодирован только encodingId 0 —
// в остальных там национальные кодировки вроде Shift-JIS. Windows идёт первой: её записи
// есть почти во всех шрифтах и именно их ждёт от EOT читатель на Windows.
//
// Внутри платформы предпочитается английский язык — как и в ttf2eot, на который кодек
// равняется: у Windows это 0x0409, у Macintosh и Unicode — 0. Без этого в конверт уехало
// бы то имя, которое в таблице стоит раньше, а порядок записей шрифт не гарантирует.
const PLATFORM_UNICODE = 0;
const PLATFORM_MACINTOSH = 1;
const PLATFORM_WINDOWS = 3;
const MAC_ROMAN_ENCODING_ID = 0;

type NameSource = {
    platformId: number;
    encodingIds?: Array<number>;
    languageId: number;
};

const NAME_SOURCES: Array<NameSource> = [
    { platformId: PLATFORM_WINDOWS, languageId: 0x0409 },
    { platformId: PLATFORM_UNICODE, languageId: 0 },
    { platformId: PLATFORM_MACINTOSH, encodingIds: [MAC_ROMAN_ENCODING_ID], languageId: 0 },
];

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

    /**
     * Разбирает каталог таблиц и ничего не возвращает: так проверяют, что перед нами sfnt.
     */
    public static validate(bytes: Uint8Array): void {
        new SfntReader(bytes);
    }

    public readMetadata(): SfntMetadata {
        // Смещения полей внутри таблиц: OS/2 — usWeightClass 4, fsType 8, panose 32,
        // ulUnicodeRange1..4 42, fsSelection 62, ulCodePageRange1..2 78 (с версии 1).
        const os2 = this.table("OS/2", OS2_VERSION_0_SIZE);
        const hasCodePageRange = this.view.getUint16(os2) >= 1;

        if (hasCodePageRange) {
            this.table("OS/2", OS2_CODE_PAGE_RANGE_OFFSET + 8);
        }

        const head = this.table("head", HEAD_MIN_SIZE);
        const names = this.readNames();

        return {
            panose: this.bytes.slice(os2 + 32, os2 + 42),
            italic: this.view.getUint16(os2 + 62) & OS2_FS_SELECTION_ITALIC,
            weight: this.view.getUint16(os2 + 4),
            fsType: this.view.getUint16(os2 + 8),
            unicodeRange: [0, 1, 2, 3].map((index) => this.view.getUint32(os2 + 42 + index * 4)),
            codePageRange: hasCodePageRange
                ? [0, 1].map((index) => this.view.getUint32(os2 + OS2_CODE_PAGE_RANGE_OFFSET + index * 4))
                : [0, 0],
            checkSumAdjustment: this.view.getUint32(head + 8),
            familyName: names.get(NAME_ID_FAMILY) ?? "",
            styleName: names.get(NAME_ID_STYLE) ?? "",
            versionName: names.get(NAME_ID_VERSION) ?? "",
            fullName: names.get(NAME_ID_FULL) ?? "",
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

    /**
     * Имена конверта по nameID. Имена информационные, поэтому нечитаемая запись здесь не
     * ошибка: её пропускают, а поле, для которого ничего не нашлось, останется пустым.
     * Отвергать из-за такого шрифт целиком дороже — записи name режут субсеттеры, а
     * таблицу целиком снимает `pyftsubset --drop-tables+=name`.
     */
    private readNames(): Map<number, string> {
        const names = new Map<number, string>();
        const name = this.tables.get("name");

        if (name === undefined || name.length < NAME_HEADER_SIZE || name.offset + NAME_HEADER_SIZE > this.bytes.length) {
            return names;
        }

        // Формат таблицы name: count 2, storageOffset 4, дальше записи по 12 байт —
        // platformId 0, encodingId 2, languageId 4, nameId 6, length 8, stringOffset 10.
        const recordCount = this.view.getUint16(name.offset + 2);
        const storage = name.offset + this.view.getUint16(name.offset + 4);
        const wanted = [NAME_ID_FAMILY, NAME_ID_STYLE, NAME_ID_VERSION, NAME_ID_FULL];

        for (const source of NAME_SOURCES) {
            // Английские записи проходятся первыми, поэтому один и тот же источник
            // перебирается дважды: сначала со своим языком, потом с любым.
            for (const languageId of [source.languageId, undefined]) {
                for (let index = 0; index < recordCount; index++) {
                    const record = name.offset + NAME_HEADER_SIZE + index * NAME_RECORD_SIZE;

                    if (record + NAME_RECORD_SIZE > this.bytes.length) {
                        return names;
                    }

                    const nameId = this.view.getUint16(record + 6);

                    if (!wanted.includes(nameId) || names.has(nameId)) {
                        continue;
                    }

                    if (this.view.getUint16(record) !== source.platformId) {
                        continue;
                    }

                    if (source.encodingIds !== undefined && !source.encodingIds.includes(this.view.getUint16(record + 2))) {
                        continue;
                    }

                    if (languageId !== undefined && this.view.getUint16(record + 4) !== languageId) {
                        continue;
                    }

                    const length = this.view.getUint16(record + 8);
                    const offset = storage + this.view.getUint16(record + 10);

                    if (offset + length > this.bytes.length) {
                        continue;
                    }

                    names.set(nameId, this.decodeName(this.bytes.subarray(offset, offset + length), source.platformId));
                }
            }
        }

        return names;
    }

    private decodeName(bytes: Uint8Array, platformId: number): string {
        if (platformId === PLATFORM_MACINTOSH) {
            // Однобайтовая кодировка платформы Macintosh — MacRoman, а не Latin-1:
            // выше 0x7f они расходятся.
            return new TextDecoder("macintosh").decode(bytes);
        }

        return new TextDecoder("utf-16be").decode(bytes);
    }
}
