import { injectable } from "inversify";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import type {
    LocaFormat,
    MaxpExpectation,
    SfntTables,
    TrueTypeOutlines,
} from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";

/**
 * Checks a TTF or OTF font against the Microsoft OpenType specification 1.9.1, and against Apple's
 * TrueType Reference Manual for what it governs: the table directory, the tables a font must
 * have, and the fields of `head`, `maxp`, `hhea`, `hmtx` and `loca` that give the glyph count,
 * where the metrics of each glyph lie and, with TrueType outlines, where its outline lies. Both
 * extensions take the same checks: the sfnt version names the outline type, not the extension, and
 * the rules that depend on the outline type go by the outline tables present, not by the version,
 * which the specification only says "should" match them.
 *
 * Deliberately not checked:
 * - The table checksums and `head.checkSumAdjustment`. fontforge does not read them: its output
 *   from a font with a wrong table checksum equals the normal output table by table, and 51 of 242
 *   macOS system fonts do not match.
 * - `searchRange`, `entrySelector` and `rangeShift`: the specification tells readers not to rely
 *   on them.
 */
@injectable()
export class SfntFontValidator implements FontValidator {
    private static readonly VERSION_OFFSET_BYTES = 0;
    private static readonly NUM_TABLES_OFFSET_BYTES = 4;
    private static readonly COLLECTION_VERSION = 0x74746366;
    private static readonly GLYF_TAG = "glyf";
    private static readonly LOCA_TAG = "loca";
    private static readonly CFF_TAG = "CFF ";
    private static readonly CFF2_TAG = "CFF2";
    private static readonly OS2_TAG = "OS/2";
    private static readonly OUTLINES_EXPECTED = '"glyf" with "loca", or "CFF "';
    private static readonly DIRECTORY_AT = "the table directory";
    private static readonly CMAP_TAG = "cmap";
    private static readonly HEAD_TAG = "head";
    private static readonly HHEA_TAG = "hhea";
    private static readonly HMTX_TAG = "hmtx";
    private static readonly MAXP_TAG = "maxp";
    private static readonly NAME_TAG = "name";
    private static readonly POST_TAG = "post";
    // The fields each table rule reads, by their offset in the table; the minimum length covers them.
    private static readonly HEAD_MIN_LENGTH_BYTES = 54;
    private static readonly HEAD_FIELD_OFFSETS_BYTES = { majorVersion: 0, magicNumber: 12, unitsPerEm: 18, indexToLocFormat: 50 };
    private static readonly HEAD_MAJOR_VERSION = 1;
    private static readonly MAGIC_NUMBER = 0x5f0f3cf5;
    private static readonly MIN_UNITS_PER_EM = 16;
    private static readonly MAX_UNITS_PER_EM = 16384;
    private static readonly SHORT_LOCA_ENTRY_SIZE_BYTES = 2;
    private static readonly LONG_LOCA_ENTRY_SIZE_BYTES = 4;
    // The short format stores the offset divided by 2, the long one the offset itself.
    private static readonly SHORT_LOCA_OFFSET_FACTOR = 2;
    private static readonly LONG_LOCA_OFFSET_FACTOR = 1;
    // By indexToLocFormat.
    private static readonly LOCA_FORMATS: ReadonlyMap<number, LocaFormat> = new Map([
        [0, { entrySizeBytes: SfntFontValidator.SHORT_LOCA_ENTRY_SIZE_BYTES, offsetFactor: SfntFontValidator.SHORT_LOCA_OFFSET_FACTOR }],
        [1, { entrySizeBytes: SfntFontValidator.LONG_LOCA_ENTRY_SIZE_BYTES, offsetFactor: SfntFontValidator.LONG_LOCA_OFFSET_FACTOR }],
    ]);
    private static readonly MAXP_FIELD_OFFSETS_BYTES = { version: 0, numGlyphs: 4 };
    private static readonly MAXP_WITH_CFF: MaxpExpectation = {
        version: 0x00005000,
        minLengthBytes: 6,
        outlinesTag: SfntFontValidator.CFF_TAG,
    };
    private static readonly MAXP_WITH_TRUETYPE: MaxpExpectation = {
        version: 0x00010000,
        minLengthBytes: 32,
        outlinesTag: SfntFontValidator.GLYF_TAG,
    };
    private static readonly HHEA_MIN_LENGTH_BYTES = 36;
    private static readonly NUMBER_OF_H_METRICS_OFFSET_BYTES = 34;
    private static readonly H_METRIC_SIZE_BYTES = 4;
    private static readonly LEFT_SIDE_BEARING_SIZE_BYTES = 2;

    /**
     * Throws when the file is not a valid sfnt font. The answers are subclasses of
     * `InvalidSfntFont`: `NotSfnt` for a file shorter than the header or of an unknown version,
     * `BrokenSfnt` for the first broken rule, checked in this order: the header, the table records
     * one by one in directory order, the tables the font has, then the content of `head`, `maxp`,
     * `hhea`, `hmtx` and, with TrueType outlines, `loca`. A file that cannot be read throws
     * `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);

        this.checkHeader(fontPath, bytes);

        const directory = new SfntTableDirectory(bytes);

        this.checkRecords(fontPath, directory.records(), bytes.length);

        const tables = this.checkTables(fontPath, directory);

        this.checkContent(fontPath, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tables);
    }

    /**
     * The header is read here, before `SfntTableDirectory` parses the same bytes: the directory
     * rejects a short file or an unknown version with the codec's `InvalidSfnt`, while an answer
     * of the validator names the rule broken. Past these checks the directory cannot throw, so
     * each check of its constructor has its rule here; the constructor says the same from its
     * side.
     */
    private checkHeader(fontPath: string, bytes: Uint8Array): void {
        const headerSizeBytes = SfntTableDirectory.HEADER_SIZE_BYTES;

        if (bytes.length < headerSizeBytes) {
            throw NotSfnt.bySize(fontPath, bytes.length, headerSizeBytes);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(SfntFontValidator.VERSION_OFFSET_BYTES);
        const at = "the header";

        if (version === SfntFontValidator.COLLECTION_VERSION) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Collection,
                at: at,
                field: "sfntVersion",
                value: `${this.hex(version)} ("ttcf")`,
                expected: this.versionsExpected(),
            });
        }

        if (!SFNT_VERSIONS.includes(version)) {
            throw NotSfnt.byVersion(fontPath, this.hex(version), this.versionsExpected());
        }

        const numTables = view.getUint16(SfntFontValidator.NUM_TABLES_OFFSET_BYTES);

        if (numTables === 0) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.TablesPresent,
                at: at,
                field: "numTables",
                value: numTables,
                expected: "at least 1",
            });
        }

        const directoryEndBytes = headerSizeBytes + numTables * SfntTableDirectory.RECORD_SIZE_BYTES;

        if (bytes.length < directoryEndBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.DirectoryInFile,
                at: "the file",
                field: "size",
                value: bytes.length,
                expected: `at least ${directoryEndBytes} for ${numTables} table records`,
            });
        }
    }

    /**
     * Ascending order with every tag once is one rule: a tag not greater than the one before it
     * breaks it, a repeated tag too.
     */
    private checkRecords(fontPath: string, records: ReadonlyArray<SfntTableRecord>, fileSizeBytes: number): void {
        let previous: SfntTableRecord | undefined;

        for (const record of records) {
            if (previous !== undefined && record.tag <= previous.tag) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.AscendingTags,
                    at: this.tableName(record.tag),
                    field: "tag",
                    value: JSON.stringify(record.tag),
                    expected: `a tag after ${JSON.stringify(previous.tag)}`,
                });
            }

            const tableEndBytes = record.offset + record.length;

            if (tableEndBytes > fileSizeBytes) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.TableInFile,
                    at: this.tableName(record.tag),
                    field: "offset + length",
                    value: tableEndBytes,
                    expected: `at most ${fileSizeBytes}, the file size`,
                });
            }

            previous = record;
        }
    }

    /**
     * CFF2 is checked before the outlines: a CFF2 font has neither glyf nor CFF, and it is to be
     * rejected for its outlines, not for their absence.
     */
    private checkTables(fontPath: string, directory: SfntTableDirectory): SfntTables {
        const at = SfntFontValidator.DIRECTORY_AT;
        // In the order the rule lists them, which is the order they are reported in.
        const required = {
            cmap: this.requiredTable(fontPath, directory, SfntFontValidator.CMAP_TAG),
            head: this.requiredTable(fontPath, directory, SfntFontValidator.HEAD_TAG),
            hhea: this.requiredTable(fontPath, directory, SfntFontValidator.HHEA_TAG),
            hmtx: this.requiredTable(fontPath, directory, SfntFontValidator.HMTX_TAG),
            maxp: this.requiredTable(fontPath, directory, SfntFontValidator.MAXP_TAG),
            name: this.requiredTable(fontPath, directory, SfntFontValidator.NAME_TAG),
            post: this.requiredTable(fontPath, directory, SfntFontValidator.POST_TAG),
        };

        if (directory.has(SfntFontValidator.CFF2_TAG)) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NoCff2,
                at: at,
                field: this.tableName(SfntFontValidator.CFF2_TAG),
                value: "present",
                expected: "absent",
            });
        }

        if (directory.has(SfntFontValidator.CFF_TAG)) {
            this.checkCffTables(fontPath, directory);

            return { ...required, trueTypeOutlines: undefined };
        }

        const glyf = directory.find(SfntFontValidator.GLYF_TAG);
        const loca = directory.find(SfntFontValidator.LOCA_TAG);

        const hasGlyf = glyf !== undefined;

        if (hasGlyf !== (loca !== undefined)) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: hasGlyf ? '"glyf" without "loca"' : '"loca" without "glyf"',
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        if (glyf === undefined || loca === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: "none",
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        return { ...required, trueTypeOutlines: { glyf: glyf, loca: loca } };
    }

    private requiredTable(fontPath: string, directory: SfntTableDirectory, tag: string): SfntTableRecord {
        const record = directory.find(tag);

        if (record === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.RequiredTable,
                at: SfntFontValidator.DIRECTORY_AT,
                field: this.tableName(tag),
                value: "absent",
                expected: "present",
            });
        }

        return record;
    }

    /**
     * A font with CFF has its outlines whatever else it holds: a glyf or a loca next to CFF is not
     * read as TrueType outlines, broken or not.
     */
    private checkCffTables(fontPath: string, directory: SfntTableDirectory): void {
        if (!directory.has(SfntFontValidator.OS2_TAG)) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Os2WithCff,
                at: SfntFontValidator.DIRECTORY_AT,
                field: this.tableName(SfntFontValidator.OS2_TAG),
                value: "absent",
                expected: 'present, as the font has "CFF "',
            });
        }
    }

    /**
     * The tables are read in the order their fields depend on each other: `head` gives the loca
     * format, `maxp` the glyph count, `hhea` the number of the hmtx records. Each table is checked
     * long enough before its fields are read, and every table lies inside the file by then.
     */
    private checkContent(fontPath: string, view: DataView, tables: SfntTables): void {
        const locaFormat = this.checkHead(fontPath, view, tables.head);
        const maxpExpected = tables.trueTypeOutlines === undefined ? SfntFontValidator.MAXP_WITH_CFF : SfntFontValidator.MAXP_WITH_TRUETYPE;
        const numGlyphs = this.checkMaxp(fontPath, view, tables.maxp, maxpExpected);
        const numberOfHMetrics = this.checkHhea(fontPath, view, tables.hhea, numGlyphs);

        this.checkHmtx(fontPath, tables.hmtx, numGlyphs, numberOfHMetrics);

        if (tables.trueTypeOutlines === undefined) {
            return;
        }

        this.checkLoca(fontPath, view, tables.trueTypeOutlines, numGlyphs, locaFormat);
    }

    private checkHead(fontPath: string, view: DataView, head: SfntTableRecord): LocaFormat {
        const at = this.tableName(SfntFontValidator.HEAD_TAG);
        const offsets = SfntFontValidator.HEAD_FIELD_OFFSETS_BYTES;

        if (head.length < SfntFontValidator.HEAD_MIN_LENGTH_BYTES) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.HeadLength,
                at: at,
                field: "length",
                value: head.length,
                expected: `at least ${SfntFontValidator.HEAD_MIN_LENGTH_BYTES}`,
            });
        }

        const majorVersion = view.getUint16(head.offset + offsets.majorVersion);

        if (majorVersion !== SfntFontValidator.HEAD_MAJOR_VERSION) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.HeadVersion,
                at: at,
                field: "majorVersion",
                value: majorVersion,
                expected: `${SfntFontValidator.HEAD_MAJOR_VERSION}`,
            });
        }

        const magicNumber = view.getUint32(head.offset + offsets.magicNumber);

        if (magicNumber !== SfntFontValidator.MAGIC_NUMBER) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.MagicNumber,
                at: at,
                field: "magicNumber",
                value: this.hex(magicNumber),
                expected: this.hex(SfntFontValidator.MAGIC_NUMBER),
            });
        }

        const unitsPerEm = view.getUint16(head.offset + offsets.unitsPerEm);

        if (unitsPerEm < SfntFontValidator.MIN_UNITS_PER_EM || unitsPerEm > SfntFontValidator.MAX_UNITS_PER_EM) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.UnitsPerEm,
                at: at,
                field: "unitsPerEm",
                value: unitsPerEm,
                expected: `from ${SfntFontValidator.MIN_UNITS_PER_EM} to ${SfntFontValidator.MAX_UNITS_PER_EM}`,
            });
        }

        // A signed field: a negative value is read as one, not as a large unsigned number.
        const indexToLocFormat = view.getInt16(head.offset + offsets.indexToLocFormat);
        const locaFormat = SfntFontValidator.LOCA_FORMATS.get(indexToLocFormat);

        if (locaFormat === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.IndexToLocFormat,
                at: at,
                field: "indexToLocFormat",
                value: indexToLocFormat,
                expected: "0 or 1",
            });
        }

        return locaFormat;
    }

    /**
     * The length is checked before the version: a table shorter than the version it should be has
     * no room for the glyph count either.
     */
    private checkMaxp(fontPath: string, view: DataView, maxp: SfntTableRecord, expected: MaxpExpectation): number {
        const at = this.tableName(SfntFontValidator.MAXP_TAG);
        const outlines = `as the font has ${this.tableName(expected.outlinesTag)}`;

        if (maxp.length < expected.minLengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.MaxpVersion,
                at: at,
                field: "length",
                value: maxp.length,
                expected: `at least ${expected.minLengthBytes}, ${outlines}`,
            });
        }

        const version = view.getUint32(maxp.offset + SfntFontValidator.MAXP_FIELD_OFFSETS_BYTES.version);

        if (version !== expected.version) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.MaxpVersion,
                at: at,
                field: "version",
                value: this.hex(version),
                expected: `${this.hex(expected.version)}, ${outlines}`,
            });
        }

        const numGlyphs = view.getUint16(maxp.offset + SfntFontValidator.MAXP_FIELD_OFFSETS_BYTES.numGlyphs);

        if (numGlyphs === 0) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NotdefGlyph,
                at: at,
                field: "numGlyphs",
                value: numGlyphs,
                expected: "at least 1",
            });
        }

        return numGlyphs;
    }

    private checkHhea(fontPath: string, view: DataView, hhea: SfntTableRecord, numGlyphs: number): number {
        const at = this.tableName(SfntFontValidator.HHEA_TAG);

        if (hhea.length < SfntFontValidator.HHEA_MIN_LENGTH_BYTES) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.HheaLength,
                at: at,
                field: "length",
                value: hhea.length,
                expected: `at least ${SfntFontValidator.HHEA_MIN_LENGTH_BYTES}`,
            });
        }

        const numberOfHMetrics = view.getUint16(hhea.offset + SfntFontValidator.NUMBER_OF_H_METRICS_OFFSET_BYTES);

        if (numberOfHMetrics < 1 || numberOfHMetrics > numGlyphs) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NumberOfHMetrics,
                at: at,
                field: "numberOfHMetrics",
                value: numberOfHMetrics,
                expected: `from 1 to ${numGlyphs}, maxp.numGlyphs`,
            });
        }

        return numberOfHMetrics;
    }

    private checkHmtx(fontPath: string, hmtx: SfntTableRecord, numGlyphs: number, numberOfHMetrics: number): void {
        const leftSideBearingCount = numGlyphs - numberOfHMetrics;
        const minLengthBytes =
            numberOfHMetrics * SfntFontValidator.H_METRIC_SIZE_BYTES +
            leftSideBearingCount * SfntFontValidator.LEFT_SIDE_BEARING_SIZE_BYTES;

        if (hmtx.length < minLengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.HmtxLength,
                at: this.tableName(SfntFontValidator.HMTX_TAG),
                field: "length",
                value: hmtx.length,
                expected: `at least ${minLengthBytes} for hMetrics[${numberOfHMetrics}] and leftSideBearings[${leftSideBearingCount}]`,
            });
        }
    }

    /**
     * The offsets are compared in bytes, the short format's stored values doubled. Ascending, the
     * offsets end with the largest, so only the last one is held against the length of glyf.
     */
    private checkLoca(fontPath: string, view: DataView, { glyf, loca }: TrueTypeOutlines, numGlyphs: number, format: LocaFormat): void {
        const at = this.tableName(SfntFontValidator.LOCA_TAG);
        const entryCount = numGlyphs + 1;
        const minLengthBytes = entryCount * format.entrySizeBytes;

        if (loca.length < minLengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.LocaLength,
                at: at,
                field: "length",
                value: loca.length,
                expected: `at least ${minLengthBytes} for offsets[${entryCount}] of ${format.entrySizeBytes} bytes`,
            });
        }

        let previousOffsetBytes = 0;

        for (let index = 0; index < entryCount; index++) {
            const offsetBytes = this.locaOffset(view, loca, format, index);

            if (offsetBytes < previousOffsetBytes) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.LocaAscending,
                    at: at,
                    field: `loca[${index}] in bytes`,
                    value: offsetBytes,
                    expected: `at least ${previousOffsetBytes}, loca[${index - 1}]`,
                });
            }

            previousOffsetBytes = offsetBytes;
        }

        if (previousOffsetBytes > glyf.length) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.LocaInGlyf,
                at: at,
                field: `loca[${numGlyphs}] in bytes`,
                value: previousOffsetBytes,
                expected: `at most ${glyf.length}, the length of ${this.tableName(SfntFontValidator.GLYF_TAG)}`,
            });
        }
    }

    private locaOffset(view: DataView, loca: SfntTableRecord, format: LocaFormat, index: number): number {
        const entryOffsetBytes = loca.offset + index * format.entrySizeBytes;
        const storedOffset =
            format.entrySizeBytes === SfntFontValidator.SHORT_LOCA_ENTRY_SIZE_BYTES
                ? view.getUint16(entryOffsetBytes)
                : view.getUint32(entryOffsetBytes);

        return storedOffset * format.offsetFactor;
    }

    private versionsExpected(): string {
        return `one of ${SFNT_VERSIONS.map((version) => this.hex(version)).join(", ")}`;
    }

    private tableName(tag: string): string {
        return `table ${JSON.stringify(tag)}`;
    }

    private hex(value: number): string {
        return `0x${value.toString(16).padStart(8, "0")}`;
    }
}
