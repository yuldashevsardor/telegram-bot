import { InvalidSfnt } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader.errors";
import type { SfntMetadata } from "app/font-convertor/eot-packer/sfnt-reader/sfnt-reader.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";

type TableRecord = {
    offset: number;
    length: number;
};

const SFNT_HEADER_SIZE = 12;
const TABLE_RECORD_SIZE = 16;

// The fields the codec reads from OS/2 end at fsSelection (62), so version 0 needs only 64
// bytes. In old fonts the table can be shorter than today's 78.
const OS2_VERSION_0_SIZE = 64;
// The code page ranges appear in version 1 and lie right after the version 0 table.
const OS2_CODE_PAGE_RANGE_OFFSET = 78;
// fsSelection bit 0 is the slant. head.macStyle duplicates it in bit 1, not 0: bit 0 there is
// bold. OS/2 is canonical for OpenType, and ttf2eot takes the slant from it too.
const OS2_FS_SELECTION_ITALIC = 0x0001;

// head is read only for checkSumAdjustment at offset 8.
const HEAD_MIN_SIZE = 12;

const NAME_HEADER_SIZE = 6;
const NAME_RECORD_SIZE = 12;
const NAME_ID_FAMILY = 1;
const NAME_ID_STYLE = 2;
const NAME_ID_FULL = 4;
const NAME_ID_VERSION = 5;

// The name table platforms whose encoding the codec can read. Windows and Unicode keep strings
// in UTF-16BE. On Macintosh only encodingId 0 is single-byte MacRoman; the others hold national
// encodings such as Shift-JIS. Windows comes first: almost every font has its records, and they
// are what a reader on Windows expects from EOT.
//
// Within a platform English is preferred, as in ttf2eot, which the codec follows: 0x0409 on
// Windows, 0 on Macintosh and Unicode. Otherwise the envelope would get whichever name stands
// earlier in the table, and a font does not guarantee the order of its records.
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
        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it differs only on a 12-byte header without a single table, which is not a font
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

            // Stryker disable next-line EqualityOperator: `>=` is equivalent: it differs only on a file without a single table byte after the directory, which is not a font
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
     * Parses the table directory and returns nothing: this is how a file is checked to be an sfnt.
     */
    public static validate(bytes: Uint8Array): void {
        new SfntReader(bytes);
    }

    public readMetadata(): SfntMetadata {
        // Field offsets inside the tables: OS/2 — usWeightClass 4, fsType 8, panose 32,
        // ulUnicodeRange1..4 42, fsSelection 62, ulCodePageRange1..2 78 (from version 1).
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
     * The envelope names by nameID. The names are informational, so an unreadable record is not an
     * error: it is skipped, and a field nothing was found for stays empty. Rejecting the whole font
     * over it costs more: subsetters cut name records, and `pyftsubset --drop-tables+=name` drops
     * the whole table.
     */
    private readNames(): Map<number, string> {
        const names = new Map<number, string>();
        const name = this.tables.get("name");

        if (name === undefined) {
            return names;
        }

        // The header, the records and the strings lie within the declared table length. Behind it
        // is the neighbouring table, and a string reaching there would carry foreign bytes into the
        // envelope. A truncated file ends even earlier.
        const nameEnd = Math.min(name.offset + name.length, this.bytes.length);

        // Stryker disable next-line EqualityOperator: `>=` is equivalent: a header ending exactly at the end of the table or the file leaves no room for a single record
        if (name.offset + NAME_HEADER_SIZE > nameEnd) {
            return names;
        }

        // The name table format: count 2, storageOffset 4, then 12-byte records —
        // platformId 0, encodingId 2, languageId 4, nameId 6, length 8, stringOffset 10.
        const recordCount = this.view.getUint16(name.offset + 2);
        const storage = name.offset + this.view.getUint16(name.offset + 4);
        // The records lie before the string storage. An inflated count, from truncation or a buggy
        // subsetter, leads them into the strings and the neighbouring tables. There bytes add up to
        // "records" with garbage names, which shadow the real names of the later sources.
        const recordsEnd = Math.min(storage, nameEnd);
        const wanted = [NAME_ID_FAMILY, NAME_ID_STYLE, NAME_ID_VERSION, NAME_ID_FULL];

        for (const source of NAME_SOURCES) {
            // Each source is walked twice, first with its language, then with any, so that English
            // records come first.
            for (const languageId of [source.languageId, undefined]) {
                for (let index = 0; index < recordCount; index++) {
                    const record = name.offset + NAME_HEADER_SIZE + index * NAME_RECORD_SIZE;

                    // The records further on are past the boundary too, so this pass is over. The
                    // other passes start from record zero and still read the records that fit.
                    if (record + NAME_RECORD_SIZE > recordsEnd) {
                        break;
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

                    if (offset + length > nameEnd) {
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
            // The single-byte encoding of the Macintosh platform is MacRoman, not Latin-1: they
            // differ above 0x7f.
            return new TextDecoder("macintosh").decode(bytes);
        }

        return new TextDecoder("utf-16be").decode(bytes);
    }
}
