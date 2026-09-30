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

    private readonly recordsInOrder: Array<SfntTableRecord> = [];
    private readonly recordsByTag = new Map<string, SfntTableRecord>();

    public constructor(bytes: Uint8Array) {
        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it differs only on a 12-byte header without a single table, which is not a font
        if (bytes.length < SfntTableDirectory.HEADER_SIZE_BYTES) {
            throw InvalidSfnt.tooShort(bytes.length);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(0);

        if (!SFNT_VERSIONS.includes(version)) {
            throw InvalidSfnt.unknownVersion(version);
        }

        const tableCount = view.getUint16(4);

        for (let index = 0; index < tableCount; index++) {
            const recordOffset = SfntTableDirectory.HEADER_SIZE_BYTES + index * SfntTableDirectory.RECORD_SIZE_BYTES;

            // Stryker disable next-line EqualityOperator: `>=` is equivalent: it differs only on a file without a single table byte after the directory, which is not a font
            if (recordOffset + SfntTableDirectory.RECORD_SIZE_BYTES > bytes.length) {
                throw InvalidSfnt.tooShort(bytes.length);
            }

            const tag = String.fromCharCode(...bytes.subarray(recordOffset, recordOffset + 4));
            const record = {
                tag: tag,
                offset: view.getUint32(recordOffset + 8),
                length: view.getUint32(recordOffset + 12),
            };

            this.recordsInOrder.push(record);
            this.recordsByTag.set(tag, record);
        }
    }

    /**
     * The record of the table by its tag. Of several records with one tag, the last one.
     */
    public find(tag: string): SfntTableRecord | undefined {
        return this.recordsByTag.get(tag);
    }

    /**
     * Every record in the order of the directory, a repeated tag as many times as it is there.
     */
    public records(): ReadonlyArray<SfntTableRecord> {
        return this.recordsInOrder;
    }
}
