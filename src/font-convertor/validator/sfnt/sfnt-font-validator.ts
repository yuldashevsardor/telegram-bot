import { injectable } from "inversify";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import type {
    CmapSubtableLengthField,
    LocaFormat,
    MaxpExpectation,
    NameRecordArray,
    NameStringRecord,
    PostGlyphNames,
    SfntTables,
    TrueTypeOutlines,
} from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";

/**
 * Checks a TTF or OTF font, or the sfnt a WOFF carries, against the Microsoft OpenType
 * specification 1.9.1, and against Apple's TrueType Reference Manual for what it governs: the table
 * directory, the tables a font must have, the fields of `head`, `maxp`, `hhea`, `hmtx` and `loca`
 * that give the glyph count, where the metrics of each glyph lie and, with TrueType outlines, where
 * its outline lies, and the version of `cmap`, `name`, `OS/2` and `post` with whether their
 * content lies inside the table: the headers and records of `cmap` and `name`, each `cmap`
 * subtable with its format and length, each non-empty `name` string, the fields of the `OS/2`
 * version, and the 32-byte header of `post` with the glyph-name index of versions 2.0 and 2.5. What
 * a subtable, a string or a glyph name holds is not read. TTF and OTF take the same checks: the sfnt version
 * names the outline type, not the extension, and the rules that depend on the outline type go by
 * the outline tables present, not by the version, which the specification only says "should" match
 * them.
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
    private static readonly CMAP_HEADER_SIZE_BYTES = 4;
    private static readonly CMAP_FIELD_OFFSETS_BYTES = { version: 0, numTables: 2 };
    private static readonly CMAP_VERSION = 0;
    private static readonly ENCODING_RECORD_SIZE_BYTES = 8;
    private static readonly SUBTABLE_OFFSET_IN_RECORD_BYTES = 4;
    private static readonly CMAP_SUBTABLE_FORMAT_SIZE_BYTES = 2;
    private static readonly SHORT_SUBTABLE_LENGTH_SIZE_BYTES = 2;
    private static readonly SHORT_LENGTH_FIELD: CmapSubtableLengthField = { offsetBytes: 2, sizeBytes: 2 };
    private static readonly LONG_LENGTH_FIELD: CmapSubtableLengthField = { offsetBytes: 4, sizeBytes: 4 };
    private static readonly VARIATION_LENGTH_FIELD: CmapSubtableLengthField = { offsetBytes: 2, sizeBytes: 4 };
    // By format: formats 0 to 6 give a 16-bit length right after the format, 8 to 13 a 32-bit one
    // after a reserved field, and 14 a 32-bit one right after the format.
    private static readonly CMAP_SUBTABLE_LENGTH_FIELDS: ReadonlyMap<number, CmapSubtableLengthField> = new Map([
        [0, SfntFontValidator.SHORT_LENGTH_FIELD],
        [2, SfntFontValidator.SHORT_LENGTH_FIELD],
        [4, SfntFontValidator.SHORT_LENGTH_FIELD],
        [6, SfntFontValidator.SHORT_LENGTH_FIELD],
        [8, SfntFontValidator.LONG_LENGTH_FIELD],
        [10, SfntFontValidator.LONG_LENGTH_FIELD],
        [12, SfntFontValidator.LONG_LENGTH_FIELD],
        [13, SfntFontValidator.LONG_LENGTH_FIELD],
        [14, SfntFontValidator.VARIATION_LENGTH_FIELD],
    ]);
    private static readonly NAME_HEADER_SIZE_BYTES = 6;
    private static readonly NAME_FIELD_OFFSETS_BYTES = { version: 0, count: 2, storageOffset: 4 };
    private static readonly NAME_VERSIONS = [0, 1];
    // Only version 1 has language-tag records.
    private static readonly NAME_VERSION_WITH_LANG_TAGS = 1;
    private static readonly NAME_RECORD: NameStringRecord = {
        label: "nameRecord",
        sizeBytes: 12,
        lengthOffsetBytes: 8,
        stringOffsetOffsetBytes: 10,
    };
    private static readonly LANG_TAG_COUNT_SIZE_BYTES = 2;
    private static readonly LANG_TAG_RECORD: NameStringRecord = {
        label: "langTagRecord",
        sizeBytes: 4,
        lengthOffsetBytes: 0,
        stringOffsetOffsetBytes: 2,
    };
    private static readonly OS2_VERSION_OFFSET_BYTES = 0;
    private static readonly OS2_VERSION_SIZE_BYTES = 2;
    // The length the fields of each version take, summed from the field lists of the specification,
    // which does not state it. Version 0 ends at usLastCharIndex, 10 bytes short of its full 78:
    // the specification warns that legacy fonts may carry it shortened so.
    private static readonly OS2_LENGTHS_BYTES: ReadonlyMap<number, number> = new Map([
        [0, 68],
        [1, 86],
        [2, 96],
        [3, 96],
        [4, 96],
        [5, 100],
    ]);
    private static readonly POST_HEADER_SIZE_BYTES = 32;
    private static readonly POST_VERSION_OFFSET_BYTES = 0;
    private static readonly POST_VERSIONS = [0x00010000, 0x00020000, 0x00025000, 0x00030000];
    private static readonly POST_NUM_GLYPHS_OFFSET_BYTES = 32;
    private static readonly POST_NUM_GLYPHS_SIZE_BYTES = 2;
    // By version: only 2.0 and 2.5 carry glyph names past the header.
    private static readonly POST_GLYPH_NAMES: ReadonlyMap<number, PostGlyphNames> = new Map([
        [0x00020000, { entries: "glyphNameIndex", entrySizeBytes: 2 }],
        [0x00025000, { entries: "offset", entrySizeBytes: 1 }],
    ]);

    /**
     * Throws when the file is not a valid sfnt font, with the answers of `validateBytes()`. A file
     * that cannot be read throws `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict
     * on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);

        this.validateBytes(fontPath, bytes);
    }

    /**
     * Throws when `bytes` are not a valid sfnt font. It takes bytes for the sfnt a WOFF carries,
     * which `WoffFontValidator` rebuilds in memory, and `fontPath` is the file every answer names.
     * The answers are subclasses of `InvalidSfntFont`: `NotSfnt` for bytes shorter than the header
     * or of an unknown version, `BrokenSfnt` for the first broken rule, checked in this order: the
     * header, the table records one by one in directory order, the tables the font has, then the
     * content of `head`, `maxp`, `hhea`, `hmtx`, with TrueType outlines `loca`, then of `cmap`,
     * `name`, `OS/2` when the font has it, and `post`.
     */
    public validateBytes(fontPath: string, bytes: Uint8Array): void {
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
        const version = view.getUint32(SfntTableDirectory.HEADER_FIELD_OFFSETS_BYTES.version);
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

        const numTables = view.getUint16(SfntTableDirectory.HEADER_FIELD_OFFSETS_BYTES.numTables);

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
        const cmap = this.requiredTable(fontPath, directory, SfntFontValidator.CMAP_TAG);
        const head = this.requiredTable(fontPath, directory, SfntFontValidator.HEAD_TAG);
        const hhea = this.requiredTable(fontPath, directory, SfntFontValidator.HHEA_TAG);
        const hmtx = this.requiredTable(fontPath, directory, SfntFontValidator.HMTX_TAG);
        const maxp = this.requiredTable(fontPath, directory, SfntFontValidator.MAXP_TAG);
        const name = this.requiredTable(fontPath, directory, SfntFontValidator.NAME_TAG);
        const post = this.requiredTable(fontPath, directory, SfntFontValidator.POST_TAG);
        const os2 = directory.find(SfntFontValidator.OS2_TAG);
        const tables = { cmap: cmap, head: head, hhea: hhea, hmtx: hmtx, maxp: maxp, name: name, os2: os2, post: post };

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
            this.checkCffTables(fontPath, os2);

            return { ...tables, trueTypeOutlines: undefined };
        }

        const glyf = directory.find(SfntFontValidator.GLYF_TAG);
        const loca = directory.find(SfntFontValidator.LOCA_TAG);
        const hasGlyf = glyf !== undefined;
        const hasLoca = loca !== undefined;

        if (hasGlyf !== hasLoca) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: hasGlyf ? '"glyf" without "loca"' : '"loca" without "glyf"',
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        if (!hasGlyf || !hasLoca) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: "none",
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        return { ...tables, trueTypeOutlines: { glyf: glyf, loca: loca } };
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
    private checkCffTables(fontPath: string, os2: SfntTableRecord | undefined): void {
        if (os2 === undefined) {
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
     * format, `maxp` the glyph count, `hhea` the number of the hmtx records. `cmap`, `name`, `OS/2`
     * and `post` depend on none of them and come last. Each table is checked long enough before its
     * fields are read, and every table lies inside the file by then.
     */
    private checkContent(fontPath: string, view: DataView, tables: SfntTables): void {
        const locaFormat = this.checkHead(fontPath, view, tables.head);
        const maxpExpected = tables.trueTypeOutlines === undefined ? SfntFontValidator.MAXP_WITH_CFF : SfntFontValidator.MAXP_WITH_TRUETYPE;
        const numGlyphs = this.checkMaxp(fontPath, view, tables.maxp, maxpExpected);
        const numberOfHMetrics = this.checkHhea(fontPath, view, tables.hhea, numGlyphs);

        this.checkHmtx(fontPath, tables.hmtx, numGlyphs, numberOfHMetrics);

        if (tables.trueTypeOutlines !== undefined) {
            this.checkLoca(fontPath, view, tables.trueTypeOutlines, numGlyphs, locaFormat);
        }

        this.checkCmap(fontPath, view, tables.cmap);
        this.checkName(fontPath, view, tables.name);

        if (tables.os2 !== undefined) {
            this.checkOs2(fontPath, view, tables.os2);
        }

        this.checkPost(fontPath, view, tables.post);
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
        const outlinesClause = `as the font has ${this.tableName(expected.outlinesTag)}`;

        if (maxp.length < expected.minLengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.MaxpVersion,
                at: at,
                field: "length",
                value: maxp.length,
                expected: `at least ${expected.minLengthBytes}, ${outlinesClause}`,
            });
        }

        const version = view.getUint32(maxp.offset + SfntFontValidator.MAXP_FIELD_OFFSETS_BYTES.version);

        if (version !== expected.version) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.MaxpVersion,
                at: at,
                field: "version",
                value: this.hex(version),
                expected: `${this.hex(expected.version)}, ${outlinesClause}`,
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

    /**
     * Of a subtable only its header is read: the format and the length.
     */
    private checkCmap(fontPath: string, view: DataView, cmap: SfntTableRecord): void {
        const at = this.tableName(SfntFontValidator.CMAP_TAG);
        const offsets = SfntFontValidator.CMAP_FIELD_OFFSETS_BYTES;
        const headerSizeBytes = SfntFontValidator.CMAP_HEADER_SIZE_BYTES;

        this.checkLength(fontPath, cmap, SfntRule.CmapRecordsInTable, headerSizeBytes, "the header");

        const version = view.getUint16(cmap.offset + offsets.version);

        if (version !== SfntFontValidator.CMAP_VERSION) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapVersion,
                at: at,
                field: "version",
                value: version,
                expected: `${SfntFontValidator.CMAP_VERSION}`,
            });
        }

        const numTables = view.getUint16(cmap.offset + offsets.numTables);

        if (numTables === 0) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtables,
                at: at,
                field: "numTables",
                value: numTables,
                expected: "at least 1",
            });
        }

        const recordsEndBytes = headerSizeBytes + numTables * SfntFontValidator.ENCODING_RECORD_SIZE_BYTES;
        const encodingRecords = `encodingRecords[${numTables}]`;

        this.checkLength(fontPath, cmap, SfntRule.CmapRecordsInTable, recordsEndBytes, `the header and ${encodingRecords}`);

        for (let index = 0; index < numTables; index++) {
            const recordOffsetBytes = headerSizeBytes + index * SfntFontValidator.ENCODING_RECORD_SIZE_BYTES;
            const subtableOffset = view.getUint32(cmap.offset + recordOffsetBytes + SfntFontValidator.SUBTABLE_OFFSET_IN_RECORD_BYTES);

            if (subtableOffset < recordsEndBytes) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.CmapSubtableInTable,
                    at: at,
                    field: `encodingRecords[${index}].subtableOffset`,
                    value: subtableOffset,
                    expected: `at least ${recordsEndBytes}, the end of the header and ${encodingRecords}`,
                });
            }

            this.checkCmapSubtable(fontPath, view, cmap, index, subtableOffset);
        }
    }

    private checkCmapSubtable(fontPath: string, view: DataView, cmap: SfntTableRecord, index: number, subtableOffset: number): void {
        this.checkSubtableRoom(
            fontPath,
            cmap,
            index,
            subtableOffset,
            SfntFontValidator.CMAP_SUBTABLE_FORMAT_SIZE_BYTES,
            `the ${SfntFontValidator.CMAP_SUBTABLE_FORMAT_SIZE_BYTES}-byte format`,
        );

        const format = view.getUint16(cmap.offset + subtableOffset);
        const lengthField = SfntFontValidator.CMAP_SUBTABLE_LENGTH_FIELDS.get(format);
        const at = this.tableName(SfntFontValidator.CMAP_TAG);

        if (lengthField === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableFormat,
                at: at,
                field: `the format of the subtable of encodingRecords[${index}]`,
                value: format,
                expected: this.oneOf([...SfntFontValidator.CMAP_SUBTABLE_LENGTH_FIELDS.keys()]),
            });
        }

        const fieldsEndBytes = lengthField.offsetBytes + lengthField.sizeBytes;

        this.checkSubtableRoom(
            fontPath,
            cmap,
            index,
            subtableOffset,
            fieldsEndBytes,
            `the ${fieldsEndBytes}-byte fields up to the length of format ${format}`,
        );

        const lengthFieldInFileBytes = cmap.offset + subtableOffset + lengthField.offsetBytes;
        const subtableLengthBytes =
            lengthField.sizeBytes === SfntFontValidator.SHORT_SUBTABLE_LENGTH_SIZE_BYTES
                ? view.getUint16(lengthFieldInFileBytes)
                : view.getUint32(lengthFieldInFileBytes);
        const restBytes = cmap.length - subtableOffset;

        if (subtableLengthBytes > restBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableLength,
                at: at,
                field: `the length of the subtable of encodingRecords[${index}]`,
                value: subtableLengthBytes,
                expected: `at most ${restBytes}, the rest of ${at} from offset ${subtableOffset}`,
            });
        }
    }

    /**
     * `fields` names what has to fit at the subtable offset. The message gives where it ends rather
     * than a bound on the offset: a cmap cut short has no offset left that the records allow.
     */
    private checkSubtableRoom(
        fontPath: string,
        cmap: SfntTableRecord,
        index: number,
        subtableOffset: number,
        sizeBytes: number,
        fields: string,
    ): void {
        const at = this.tableName(SfntFontValidator.CMAP_TAG);

        if (subtableOffset + sizeBytes > cmap.length) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableInTable,
                at: at,
                field: `the end of ${fields} of the subtable of encodingRecords[${index}]`,
                value: subtableOffset + sizeBytes,
                expected: `at most ${cmap.length}, the length of ${at}`,
            });
        }
    }

    /**
     * Where each string lies is checked, what it holds is not: on a string that runs past the table
     * fontforge 20230101 crashed with SIGSEGV in 7 of the 14 variants measured, and put foreign
     * bytes into the names in 2 more.
     */
    private checkName(fontPath: string, view: DataView, name: SfntTableRecord): void {
        const offsets = SfntFontValidator.NAME_FIELD_OFFSETS_BYTES;

        this.checkLength(fontPath, name, SfntRule.NameRecordsInTable, SfntFontValidator.NAME_HEADER_SIZE_BYTES, "the header");

        const version = view.getUint16(name.offset + offsets.version);

        if (!SfntFontValidator.NAME_VERSIONS.includes(version)) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NameVersion,
                at: this.tableName(SfntFontValidator.NAME_TAG),
                field: "version",
                value: version,
                expected: this.oneOf(SfntFontValidator.NAME_VERSIONS),
            });
        }

        const storageOffset = view.getUint16(name.offset + offsets.storageOffset);
        const recordArrays = this.checkNameRecords(fontPath, view, name, version, storageOffset);

        for (const records of recordArrays) {
            this.checkNameStrings(fontPath, view, name, storageOffset, records);
        }
    }

    /**
     * Checks that the records fit into the table and end before the string storage, and returns
     * them in table order: the name records, then with version 1 the language-tag records.
     */
    private checkNameRecords(
        fontPath: string,
        view: DataView,
        name: SfntTableRecord,
        version: number,
        storageOffset: number,
    ): NameRecordArray[] {
        const headerSizeBytes = SfntFontValidator.NAME_HEADER_SIZE_BYTES;
        const count = view.getUint16(name.offset + SfntFontValidator.NAME_FIELD_OFFSETS_BYTES.count);
        const recordsEndBytes = headerSizeBytes + count * SfntFontValidator.NAME_RECORD.sizeBytes;
        const nameRecords = `nameRecord[${count}]`;
        const nameRecordArray = { record: SfntFontValidator.NAME_RECORD, startBytes: headerSizeBytes, count: count };

        this.checkLength(fontPath, name, SfntRule.NameRecordsInTable, recordsEndBytes, `the header and ${nameRecords}`);

        if (version !== SfntFontValidator.NAME_VERSION_WITH_LANG_TAGS) {
            this.checkStorageOffset(fontPath, storageOffset, recordsEndBytes, nameRecords);

            return [nameRecordArray];
        }

        const langTagCountEndBytes = recordsEndBytes + SfntFontValidator.LANG_TAG_COUNT_SIZE_BYTES;

        this.checkLength(fontPath, name, SfntRule.NameRecordsInTable, langTagCountEndBytes, `the header, ${nameRecords} and langTagCount`);

        const langTagCount = view.getUint16(name.offset + recordsEndBytes);
        const langTagRecordsEndBytes = langTagCountEndBytes + langTagCount * SfntFontValidator.LANG_TAG_RECORD.sizeBytes;

        this.checkLength(
            fontPath,
            name,
            SfntRule.NameRecordsInTable,
            langTagRecordsEndBytes,
            `the header, ${nameRecords}, langTagCount and langTagRecord[${langTagCount}]`,
        );
        this.checkStorageOffset(fontPath, storageOffset, langTagRecordsEndBytes, `langTagRecord[${langTagCount}]`);

        return [nameRecordArray, { record: SfntFontValidator.LANG_TAG_RECORD, startBytes: langTagCountEndBytes, count: langTagCount }];
    }

    /**
     * `lastRecords` names the record array that ends at `recordsEndBytes`.
     */
    private checkStorageOffset(fontPath: string, storageOffset: number, recordsEndBytes: number, lastRecords: string): void {
        if (storageOffset < recordsEndBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NameStorageAfterRecords,
                at: this.tableName(SfntFontValidator.NAME_TAG),
                field: "storageOffset",
                value: storageOffset,
                expected: `at least ${recordsEndBytes}, the end of ${lastRecords}`,
            });
        }
    }

    private checkNameStrings(
        fontPath: string,
        view: DataView,
        name: SfntTableRecord,
        storageOffset: number,
        records: NameRecordArray,
    ): void {
        const { record, startBytes, count } = records;
        const at = this.tableName(SfntFontValidator.NAME_TAG);

        for (let index = 0; index < count; index++) {
            const recordOffsetBytes = name.offset + startBytes + index * record.sizeBytes;
            const lengthBytes = view.getUint16(recordOffsetBytes + record.lengthOffsetBytes);

            // An empty string has no byte to read: fontforge converts it at any offset.
            if (lengthBytes === 0) {
                continue;
            }

            const stringOffset = view.getUint16(recordOffsetBytes + record.stringOffsetOffsetBytes);
            const stringEndBytes = storageOffset + stringOffset + lengthBytes;

            if (stringEndBytes > name.length) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.NameStringInTable,
                    at: at,
                    field: `the end of the string of ${record.label}[${index}]`,
                    value: stringEndBytes,
                    expected: `at most ${name.length}, the length of ${at}`,
                });
            }
        }
    }

    private checkOs2(fontPath: string, view: DataView, os2: SfntTableRecord): void {
        this.checkLength(fontPath, os2, SfntRule.Os2Length, SfntFontValidator.OS2_VERSION_SIZE_BYTES, "the version");

        const version = view.getUint16(os2.offset + SfntFontValidator.OS2_VERSION_OFFSET_BYTES);
        const minLengthBytes = SfntFontValidator.OS2_LENGTHS_BYTES.get(version);

        if (minLengthBytes === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Os2Version,
                at: this.tableName(SfntFontValidator.OS2_TAG),
                field: "version",
                value: version,
                expected: this.oneOf([...SfntFontValidator.OS2_LENGTHS_BYTES.keys()]),
            });
        }

        this.checkLength(fontPath, os2, SfntRule.Os2Length, minLengthBytes, `version ${version}`);
    }

    /**
     * The header is the same for every version, so its length is checked before the version is read.
     */
    private checkPost(fontPath: string, view: DataView, post: SfntTableRecord): void {
        this.checkLength(fontPath, post, SfntRule.PostLength, SfntFontValidator.POST_HEADER_SIZE_BYTES, "the header");

        const version = view.getUint32(post.offset + SfntFontValidator.POST_VERSION_OFFSET_BYTES);

        if (!SfntFontValidator.POST_VERSIONS.includes(version)) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.PostVersion,
                at: this.tableName(SfntFontValidator.POST_TAG),
                field: "version",
                value: this.hex(version),
                expected: this.oneOf(SfntFontValidator.POST_VERSIONS.map((postVersion) => this.hex(postVersion))),
            });
        }

        const glyphNames = SfntFontValidator.POST_GLYPH_NAMES.get(version);

        if (glyphNames === undefined) {
            return;
        }

        const numGlyphsEndBytes = SfntFontValidator.POST_NUM_GLYPHS_OFFSET_BYTES + SfntFontValidator.POST_NUM_GLYPHS_SIZE_BYTES;

        this.checkLength(fontPath, post, SfntRule.PostLength, numGlyphsEndBytes, "the header and numGlyphs");

        const numGlyphs = view.getUint16(post.offset + SfntFontValidator.POST_NUM_GLYPHS_OFFSET_BYTES);
        const entriesEndBytes = numGlyphsEndBytes + numGlyphs * glyphNames.entrySizeBytes;

        this.checkLength(
            fontPath,
            post,
            SfntRule.PostLength,
            entriesEndBytes,
            `the header, numGlyphs and ${glyphNames.entries}[${numGlyphs}]`,
        );
    }

    /**
     * The length rules of cmap, name, OS/2 and post: `fields` names what the minimum length holds.
     */
    private checkLength(fontPath: string, table: SfntTableRecord, rule: SfntRule, minLengthBytes: number, fields: string): void {
        if (table.length < minLengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: rule,
                at: this.tableName(table.tag),
                field: "length",
                value: table.length,
                expected: `at least ${minLengthBytes} for ${fields}`,
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
        return this.oneOf(SFNT_VERSIONS.map((version) => this.hex(version)));
    }

    private oneOf(values: ReadonlyArray<number | string>): string {
        return `one of ${values.join(", ")}`;
    }

    private tableName(tag: string): string {
        return `table ${JSON.stringify(tag)}`;
    }

    private hex(value: number): string {
        return `0x${value.toString(16).padStart(8, "0")}`;
    }
}
