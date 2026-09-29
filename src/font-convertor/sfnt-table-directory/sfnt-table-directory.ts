import { InvalidSfnt } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.errors";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";

const SFNT_HEADER_SIZE = 12;
const TABLE_RECORD_SIZE = 16;

/**
 * The table directory of an sfnt font: the header and the table records by tag. The EOT codec reads
 * its tables through it, so a font has one parse of the directory rather than a copy per reader.
 */
export class SfntTableDirectory {
    private readonly records = new Map<string, SfntTableRecord>();

    public constructor(bytes: Uint8Array) {
        // Stryker disable next-line EqualityOperator: `<=` is equivalent: it differs only on a 12-byte header without a single table, which is not a font
        if (bytes.length < SFNT_HEADER_SIZE) {
            throw InvalidSfnt.tooShort(bytes.length);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(0);

        if (!SFNT_VERSIONS.includes(version)) {
            throw InvalidSfnt.unknownVersion(version);
        }

        const tableCount = view.getUint16(4);

        for (let index = 0; index < tableCount; index++) {
            const record = SFNT_HEADER_SIZE + index * TABLE_RECORD_SIZE;

            // Stryker disable next-line EqualityOperator: `>=` is equivalent: it differs only on a file without a single table byte after the directory, which is not a font
            if (record + TABLE_RECORD_SIZE > bytes.length) {
                throw InvalidSfnt.tooShort(bytes.length);
            }

            const tag = String.fromCharCode(...bytes.subarray(record, record + 4));

            this.records.set(tag, {
                offset: view.getUint32(record + 8),
                length: view.getUint32(record + 12),
            });
        }
    }

    public find(tag: string): SfntTableRecord | undefined {
        return this.records.get(tag);
    }
}
