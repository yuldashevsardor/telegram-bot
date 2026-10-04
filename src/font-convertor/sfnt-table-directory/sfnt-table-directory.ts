import { InvalidSfnt } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.errors";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";

/**
 * The table directory of an sfnt font: the header and the table records, by tag and in the order of
 * the directory. The EOT codec and `SfntFontValidator` read the records through it, so the domain
 * has one implementation of the parse rather than a copy per reader.
 */
export class SfntTableDirectory {
    public static readonly HEADER_SIZE_BYTES = 12;
    public static readonly RECORD_SIZE_BYTES = 16;
    // The offsets of the header fields, and of the fields in a table record after the tag that
    // opens it (OpenType 1.9.1, Table Directory).
    public static readonly HEADER_FIELD_OFFSETS_BYTES = {
        version: 0,
        numTables: 4,
        searchRange: 6,
        entrySelector: 8,
        rangeShift: 10,
    } as const;
    public static readonly RECORD_FIELD_OFFSETS_BYTES = { checksum: 4, offset: 8, length: 12 } as const;

    private readonly recordsInOrder: Array<SfntTableRecord> = [];
    private readonly recordsByTag = new Map<string, SfntTableRecord>();

    /**
     * `SfntFontValidator.checkHeader()` repeats every check that throws here, as a rule of its
     * own, before it constructs the directory: a check added here without a rule there lets the
     * codec's `InvalidSfnt` out of the validator instead of its answer.
     */
    public constructor(bytes: Uint8Array) {
        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it differs only on a 12-byte header without a single table, which is not a font
        if (bytes.length < SfntTableDirectory.HEADER_SIZE_BYTES) {
            throw InvalidSfnt.tooShort(bytes.length);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const headerFields = SfntTableDirectory.HEADER_FIELD_OFFSETS_BYTES;
        const version = view.getUint32(headerFields.version);

        if (!SFNT_VERSIONS.includes(version)) {
            throw InvalidSfnt.unknownVersion(version);
        }

        const tableCount = view.getUint16(headerFields.numTables);

        for (let index = 0; index < tableCount; index++) {
            const recordOffset = SfntTableDirectory.HEADER_SIZE_BYTES + index * SfntTableDirectory.RECORD_SIZE_BYTES;

            // Stryker disable next-line EqualityOperator: `>=` is equivalent: it differs only on a file without a single table byte after the directory, which is not a font
            if (recordOffset + SfntTableDirectory.RECORD_SIZE_BYTES > bytes.length) {
                throw InvalidSfnt.tooShort(bytes.length);
            }

            const tag = String.fromCharCode(...bytes.subarray(recordOffset, recordOffset + 4));
            const record = {
                tag: tag,
                offset: view.getUint32(recordOffset + SfntTableDirectory.RECORD_FIELD_OFFSETS_BYTES.offset),
                length: view.getUint32(recordOffset + SfntTableDirectory.RECORD_FIELD_OFFSETS_BYTES.length),
            };

            this.recordsInOrder.push(record);
            this.recordsByTag.set(tag, record);
        }
    }

    /**
     * Writes the header of an sfnt that has `tableCount` records: the version and the table count,
     * with `searchRange`, `entrySelector` and `rangeShift` computed as OpenType 1.9.1 (Table
     * Directory) asks. The WOFF and WOFF2 validators rebuild the sfnt they carry with it.
     */
    public static writeHeader(sfnt: Uint8Array, version: number, tableCount: number): void {
        const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
        const headerFields = SfntTableDirectory.HEADER_FIELD_OFFSETS_BYTES;
        // entrySelector is the exponent of the largest power of 2 not greater than the table count,
        // and searchRange is that power of 2 times the record size, in bytes. From 4096 tables on it
        // does not fit its 16 bits and setUint16 wraps it: OpenType gives no value for that case, and
        // SfntFontValidator does not read the field.
        const entrySelector = Math.floor(Math.log2(tableCount));
        const searchRangeBytes = 2 ** entrySelector * SfntTableDirectory.RECORD_SIZE_BYTES;

        view.setUint32(headerFields.version, version);
        view.setUint16(headerFields.numTables, tableCount);
        view.setUint16(headerFields.searchRange, searchRangeBytes);
        view.setUint16(headerFields.entrySelector, entrySelector);
        view.setUint16(headerFields.rangeShift, tableCount * SfntTableDirectory.RECORD_SIZE_BYTES - searchRangeBytes);
    }

    /**
     * The record of the table by its tag. Of several records with one tag, the last one.
     */
    public find(tag: string): SfntTableRecord | undefined {
        return this.recordsByTag.get(tag);
    }

    public has(tag: string): boolean {
        return this.recordsByTag.has(tag);
    }

    /**
     * Every record in the order of the directory, a repeated tag as many times as it is there.
     */
    public records(): ReadonlyArray<SfntTableRecord> {
        return this.recordsInOrder;
    }
}
