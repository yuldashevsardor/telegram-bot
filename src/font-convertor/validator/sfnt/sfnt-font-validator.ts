import { injectable } from "inversify";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import type {
    CmapSubtableLayout,
    CmapSubtableLengthField,
    ComponentWalk,
    CoordinateFlagBits,
    FlagsLayout,
    GlyfEntry,
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
 * its outline lies, the header of every glyph in `glyf` and whether the fields of each simple glyph
 * and the components of each composite glyph lie inside it, the components pointing at glyphs of
 * the font without a cycle, and the version of `cmap`, `name`, `OS/2` and `post` with whether their
 * content lies inside the table: the headers and records of `cmap` and `name`, each `cmap` subtable
 * with its format and a length that covers the part of its format of a set size, each non-empty
 * `name` string, the fields of the `OS/2` version, and the 32-byte header of `post` with the
 * glyph-name index of versions 2.0 and 2.5, held against the glyph count of `maxp`, and with 2.0 the
 * glyph names the index points at. What a subtable, a string or a glyph name holds is not read, nor
 * are the values of a glyph's coordinates, arguments and transform and its instructions. TTF and
 * OTF take the same checks: the sfnt version names the outline type, not the extension, and the
 * rules that depend on the outline type go by the outline tables present, not by the version, which
 * the specification only says "should" match them.
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
    private static readonly GLYPH_HEADER_SIZE_BYTES = 10;
    private static readonly NUMBER_OF_CONTOURS_OFFSET_BYTES = 0;
    private static readonly END_PT_SIZE_BYTES = 2;
    private static readonly INSTRUCTION_LENGTH_SIZE_BYTES = 2;
    private static readonly FLAG_SIZE_BYTES = 1;
    private static readonly REPEAT_COUNT_SIZE_BYTES = 1;
    private static readonly REPEAT_FLAG = 0x08;
    private static readonly X_COORDINATE_FLAGS: CoordinateFlagBits = { shortVector: 0x02, sameOrPositive: 0x10 };
    private static readonly Y_COORDINATE_FLAGS: CoordinateFlagBits = { shortVector: 0x04, sameOrPositive: 0x20 };
    private static readonly SHORT_COORDINATE_SIZE_BYTES = 1;
    private static readonly LONG_COORDINATE_SIZE_BYTES = 2;
    // A coordinate the same as the previous one is not stored.
    private static readonly SAME_COORDINATE_SIZE_BYTES = 0;
    // A component opens with its flags and glyphIndex; the flags give the width of what follows.
    private static readonly COMPONENT_FLAGS_SIZE_BYTES = 2;
    private static readonly COMPONENT_GLYPH_INDEX_SIZE_BYTES = 2;
    private static readonly ARG_1_AND_2_ARE_WORDS = 0x0001;
    private static readonly WE_HAVE_A_SCALE = 0x0008;
    private static readonly MORE_COMPONENTS = 0x0020;
    private static readonly WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
    private static readonly WE_HAVE_A_TWO_BY_TWO = 0x0080;
    private static readonly WE_HAVE_INSTRUCTIONS = 0x0100;
    // argument1 and argument2: two words with ARG_1_AND_2_ARE_WORDS, two bytes without.
    private static readonly WORD_ARGUMENTS_SIZE_BYTES = 4;
    private static readonly BYTE_ARGUMENTS_SIZE_BYTES = 2;
    // One, two or four F2DOT14 values by the scale flag.
    private static readonly SCALE_SIZE_BYTES = 2;
    private static readonly X_AND_Y_SCALE_SIZE_BYTES = 4;
    private static readonly TWO_BY_TWO_SIZE_BYTES = 8;
    private static readonly NO_TRANSFORM_SIZE_BYTES = 0;
    private static readonly NUM_INSTR_SIZE_BYTES = 2;
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
    // after a reserved field, and 14 a 32-bit one right after the format. The part of a set size,
    // summed from the field lists of the specification: format 0 holds 3 fields and glyphIdArray[256],
    // 2 holds 3 fields and subHeaderKeys[256], 8 holds 4 fields, is32[8192] and numGroups.
    private static readonly CMAP_SUBTABLE_LAYOUTS: ReadonlyMap<number, CmapSubtableLayout> = new Map([
        [0, { lengthField: SfntFontValidator.SHORT_LENGTH_FIELD, fixedSizeBytes: 262 }],
        [2, { lengthField: SfntFontValidator.SHORT_LENGTH_FIELD, fixedSizeBytes: 518 }],
        [4, { lengthField: SfntFontValidator.SHORT_LENGTH_FIELD, fixedSizeBytes: 14 }],
        [6, { lengthField: SfntFontValidator.SHORT_LENGTH_FIELD, fixedSizeBytes: 10 }],
        [8, { lengthField: SfntFontValidator.LONG_LENGTH_FIELD, fixedSizeBytes: 8208 }],
        [10, { lengthField: SfntFontValidator.LONG_LENGTH_FIELD, fixedSizeBytes: 20 }],
        [12, { lengthField: SfntFontValidator.LONG_LENGTH_FIELD, fixedSizeBytes: 16 }],
        [13, { lengthField: SfntFontValidator.LONG_LENGTH_FIELD, fixedSizeBytes: 16 }],
        [14, { lengthField: SfntFontValidator.VARIATION_LENGTH_FIELD, fixedSizeBytes: 10 }],
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
    // An index of 2.0 below 258 names a standard Macintosh glyph, 258 and above the Pascal string at
    // the index minus 258.
    private static readonly POST_STANDARD_NAME_COUNT = 258;
    private static readonly PASCAL_STRING_LENGTH_SIZE_BYTES = 1;
    private static readonly GLYPH_NAME_INDEX_SIZE_BYTES = 2;
    private static readonly GLYPH_NAME_OFFSET_SIZE_BYTES = 1;
    // By version: only 2.0 and 2.5 carry glyph names past the header, and only 2.0 names of its own.
    private static readonly POST_GLYPH_NAMES: ReadonlyMap<number, PostGlyphNames> = new Map([
        [0x00020000, { entries: "glyphNameIndex", entrySizeBytes: SfntFontValidator.GLYPH_NAME_INDEX_SIZE_BYTES, hasNameStrings: true }],
        [0x00025000, { entries: "offset", entrySizeBytes: SfntFontValidator.GLYPH_NAME_OFFSET_SIZE_BYTES, hasNameStrings: false }],
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
     * content of `head`, `maxp`, `hhea`, `hmtx`, with TrueType outlines `loca` and `glyf`, glyph by
     * glyph, then the references between composite glyphs, then of `cmap`, `name`, `OS/2` when the
     * font has it, and `post`.
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
     * and `post` come last: of them only `post` depends on another table, on the glyph count. Each
     * table is checked long enough before its fields are read, and every table lies inside the file
     * by then.
     */
    private checkContent(fontPath: string, view: DataView, tables: SfntTables): void {
        const locaFormat = this.checkHead(fontPath, view, tables.head);
        const maxpExpected = tables.trueTypeOutlines === undefined ? SfntFontValidator.MAXP_WITH_CFF : SfntFontValidator.MAXP_WITH_TRUETYPE;
        const numGlyphs = this.checkMaxp(fontPath, view, tables.maxp, maxpExpected);
        const numberOfHMetrics = this.checkHhea(fontPath, view, tables.hhea, numGlyphs);

        this.checkHmtx(fontPath, tables.hmtx, numGlyphs, numberOfHMetrics);

        if (tables.trueTypeOutlines !== undefined) {
            this.checkLoca(fontPath, view, tables.trueTypeOutlines, numGlyphs, locaFormat);
            this.checkGlyf(fontPath, view, tables.trueTypeOutlines, numGlyphs, locaFormat);
        }

        this.checkCmap(fontPath, view, tables.cmap);
        this.checkName(fontPath, view, tables.name);

        if (tables.os2 !== undefined) {
            this.checkOs2(fontPath, view, tables.os2);
        }

        this.checkPost(fontPath, view, tables.post, numGlyphs);
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
     * Walks every glyph with an outline, loca[n] < loca[n+1]. loca is checked by then, so each glyph
     * lies inside glyf. The references between composite glyphs are checked once every glyph is
     * read: a cycle can close at a glyph past the one that opens it.
     */
    private checkGlyf(fontPath: string, view: DataView, { glyf, loca }: TrueTypeOutlines, numGlyphs: number, format: LocaFormat): void {
        const componentsByGlyph = new Map<number, ReadonlyArray<number>>();

        for (let glyphId = 0; glyphId < numGlyphs; glyphId++) {
            const startBytes = this.locaOffset(view, loca, format, glyphId);
            const endBytes = this.locaOffset(view, loca, format, glyphId + 1);
            const glyph = { id: glyphId, offsetBytes: glyf.offset + startBytes, lengthBytes: endBytes - startBytes };

            if (glyph.lengthBytes === 0) {
                continue;
            }

            const componentGlyphIds = this.checkGlyph(fontPath, view, glyph, numGlyphs);

            if (componentGlyphIds.length > 0) {
                componentsByGlyph.set(glyphId, componentGlyphIds);
            }
        }

        this.checkComponentCycles(fontPath, componentsByGlyph);
    }

    /**
     * Returns the glyphs the components of a composite glyph point at, in their order, and none for
     * a simple glyph. A negative numberOfContours makes a composite glyph. Any negative value
     * passes: the specification says -1 "should be used", and fontforge 20230101 reads -2 and
     * -32768 as a composite glyph too, losing nothing.
     */
    private checkGlyph(fontPath: string, view: DataView, glyph: GlyfEntry, numGlyphs: number): ReadonlyArray<number> {
        if (glyph.lengthBytes < SfntFontValidator.GLYPH_HEADER_SIZE_BYTES) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.GlyphHeader,
                at: this.tableName(SfntFontValidator.GLYF_TAG),
                field: `the length of glyph ${glyph.id} by loca`,
                value: glyph.lengthBytes,
                expected: `0 or at least ${SfntFontValidator.GLYPH_HEADER_SIZE_BYTES}`,
            });
        }

        const numberOfContours = view.getInt16(glyph.offsetBytes + SfntFontValidator.NUMBER_OF_CONTOURS_OFFSET_BYTES);

        if (numberOfContours < 0) {
            return this.checkCompositeGlyph(fontPath, view, glyph, numGlyphs);
        }

        this.checkSimpleGlyph(fontPath, view, glyph, numberOfContours);

        return [];
    }

    /**
     * The fields follow one another, each placed by the ones before it, so each is checked to fit
     * into the glyph before it is read. Positions are counted from the start of the glyph.
     */
    private checkSimpleGlyph(fontPath: string, view: DataView, glyph: GlyfEntry, numberOfContours: number): void {
        const endPtsEndBytes = SfntFontValidator.GLYPH_HEADER_SIZE_BYTES + numberOfContours * SfntFontValidator.END_PT_SIZE_BYTES;

        this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, endPtsEndBytes, `endPtsOfContours[${numberOfContours}]`);

        const numberOfPoints = this.checkEndPtsOfContours(fontPath, view, glyph, numberOfContours);
        const instructionLengthEndBytes = endPtsEndBytes + SfntFontValidator.INSTRUCTION_LENGTH_SIZE_BYTES;

        this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, instructionLengthEndBytes, "instructionLength");

        const instructionLength = view.getUint16(glyph.offsetBytes + endPtsEndBytes);
        const instructionsEndBytes = instructionLengthEndBytes + instructionLength;

        this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, instructionsEndBytes, `instructions[${instructionLength}]`);

        const flags = this.checkFlags(fontPath, view, glyph, instructionsEndBytes, numberOfPoints);
        const xCoordinatesEndBytes = flags.flagsEndBytes + flags.xCoordinatesSizeBytes;

        this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, xCoordinatesEndBytes, "xCoordinates");
        this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, xCoordinatesEndBytes + flags.yCoordinatesSizeBytes, "yCoordinates");
    }

    /**
     * Returns the number of points: the points are numbered from 0, so the last contour ends at the
     * last point, and a glyph without contours has none.
     */
    private checkEndPtsOfContours(fontPath: string, view: DataView, glyph: GlyfEntry, numberOfContours: number): number {
        let previousEndPt = -1;

        for (let index = 0; index < numberOfContours; index++) {
            const endPt = view.getUint16(
                glyph.offsetBytes + SfntFontValidator.GLYPH_HEADER_SIZE_BYTES + index * SfntFontValidator.END_PT_SIZE_BYTES,
            );

            if (endPt <= previousEndPt) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.EndPtsAscending,
                    at: this.tableName(SfntFontValidator.GLYF_TAG),
                    field: `endPtsOfContours[${index}] of glyph ${glyph.id}`,
                    value: endPt,
                    expected: `more than ${previousEndPt}, endPtsOfContours[${index - 1}]`,
                });
            }

            previousEndPt = endPt;
        }

        return previousEndPt + 1;
    }

    /**
     * Reads one flag per point, a repeated flag standing for its repeats too, and sums the widths
     * of the coordinates the flags give. The messages name a flag by the point it opens: after a
     * flag with repeats the next stored flag is that of a later point.
     */
    private checkFlags(fontPath: string, view: DataView, glyph: GlyfEntry, startBytes: number, numberOfPoints: number): FlagsLayout {
        let positionBytes = startBytes;
        let flagCount = 0;
        let xCoordinatesSizeBytes = 0;
        let yCoordinatesSizeBytes = 0;

        while (flagCount < numberOfPoints) {
            const flagOfPoint = `the flag of point ${flagCount}`;

            this.checkInGlyph(fontPath, glyph, SfntRule.SimpleGlyphInData, positionBytes + SfntFontValidator.FLAG_SIZE_BYTES, flagOfPoint);

            const flag = view.getUint8(glyph.offsetBytes + positionBytes);
            let repeatCount = 0;

            positionBytes += SfntFontValidator.FLAG_SIZE_BYTES;

            if ((flag & SfntFontValidator.REPEAT_FLAG) !== 0) {
                this.checkInGlyph(
                    fontPath,
                    glyph,
                    SfntRule.SimpleGlyphInData,
                    positionBytes + SfntFontValidator.REPEAT_COUNT_SIZE_BYTES,
                    `the repeat count of ${flagOfPoint}`,
                );
                repeatCount = view.getUint8(glyph.offsetBytes + positionBytes);
                positionBytes += SfntFontValidator.REPEAT_COUNT_SIZE_BYTES;
            }

            const flagsGiven = 1 + repeatCount;

            if (flagCount + flagsGiven > numberOfPoints) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.FlagPerPoint,
                    at: this.tableName(SfntFontValidator.GLYF_TAG),
                    field: `the flag count with ${flagOfPoint} and its ${repeatCount} repeats of glyph ${glyph.id}`,
                    value: flagCount + flagsGiven,
                    expected: `at most ${numberOfPoints}, the number of points`,
                });
            }

            xCoordinatesSizeBytes += flagsGiven * this.coordinateSizeBytes(flag, SfntFontValidator.X_COORDINATE_FLAGS);
            yCoordinatesSizeBytes += flagsGiven * this.coordinateSizeBytes(flag, SfntFontValidator.Y_COORDINATE_FLAGS);
            flagCount += flagsGiven;
        }

        return { flagsEndBytes: positionBytes, xCoordinatesSizeBytes: xCoordinatesSizeBytes, yCoordinatesSizeBytes: yCoordinatesSizeBytes };
    }

    private coordinateSizeBytes(flag: number, bits: CoordinateFlagBits): number {
        if ((flag & bits.shortVector) !== 0) {
            return SfntFontValidator.SHORT_COORDINATE_SIZE_BYTES;
        }

        if ((flag & bits.sameOrPositive) !== 0) {
            return SfntFontValidator.SAME_COORDINATE_SIZE_BYTES;
        }

        return SfntFontValidator.LONG_COORDINATE_SIZE_BYTES;
    }

    /**
     * Reads the components one by one while MORE_COMPONENTS is set, each checked to fit into the
     * glyph before its fields are read, the first one too: a composite glyph has at least one.
     * Returns the glyphs they point at. The instructions follow the last component when any
     * component sets WE_HAVE_INSTRUCTIONS, as the specification has it; fontforge 20230101 reads
     * the flag of the last one only. The reserved bits of the flags are not checked: 42 132
     * components of 36 of the 297 real fonts with TrueType outlines measured set them, Arial among
     * them.
     */
    private checkCompositeGlyph(fontPath: string, view: DataView, glyph: GlyfEntry, numGlyphs: number): ReadonlyArray<number> {
        const componentGlyphIds: number[] = [];
        let positionBytes = SfntFontValidator.GLYPH_HEADER_SIZE_BYTES;
        let hasInstructions = false;
        let hasMoreComponents = true;

        while (hasMoreComponents) {
            const componentLabel = `component ${componentGlyphIds.length}`;
            const glyphIndexOffsetBytes = positionBytes + SfntFontValidator.COMPONENT_FLAGS_SIZE_BYTES;
            const glyphIndexEndBytes = glyphIndexOffsetBytes + SfntFontValidator.COMPONENT_GLYPH_INDEX_SIZE_BYTES;

            this.checkInGlyph(
                fontPath,
                glyph,
                SfntRule.CompositeGlyphInData,
                glyphIndexEndBytes,
                `the flags and glyphIndex of ${componentLabel}`,
            );

            const flags = view.getUint16(glyph.offsetBytes + positionBytes);
            const componentGlyphId = view.getUint16(glyph.offsetBytes + glyphIndexOffsetBytes);

            if (componentGlyphId >= numGlyphs) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.ComponentGlyphIndex,
                    at: this.tableName(SfntFontValidator.GLYF_TAG),
                    field: `the glyphIndex of ${componentLabel} of glyph ${glyph.id}`,
                    value: componentGlyphId,
                    expected: `less than ${numGlyphs}, maxp.numGlyphs`,
                });
            }

            const argumentsEndBytes = glyphIndexEndBytes + this.argumentsSizeBytes(flags);

            this.checkInGlyph(fontPath, glyph, SfntRule.CompositeGlyphInData, argumentsEndBytes, `the arguments of ${componentLabel}`);

            const transformEndBytes = argumentsEndBytes + this.transformSizeBytes(flags);

            this.checkInGlyph(fontPath, glyph, SfntRule.CompositeGlyphInData, transformEndBytes, `the transform of ${componentLabel}`);

            componentGlyphIds.push(componentGlyphId);
            positionBytes = transformEndBytes;
            hasInstructions = hasInstructions || (flags & SfntFontValidator.WE_HAVE_INSTRUCTIONS) !== 0;
            hasMoreComponents = (flags & SfntFontValidator.MORE_COMPONENTS) !== 0;
        }

        if (hasInstructions) {
            this.checkCompositeInstructions(fontPath, view, glyph, positionBytes);
        }

        return componentGlyphIds;
    }

    private argumentsSizeBytes(flags: number): number {
        if ((flags & SfntFontValidator.ARG_1_AND_2_ARE_WORDS) !== 0) {
            return SfntFontValidator.WORD_ARGUMENTS_SIZE_BYTES;
        }

        return SfntFontValidator.BYTE_ARGUMENTS_SIZE_BYTES;
    }

    /**
     * The specification makes the three scale flags mutually exclusive; this check does not hold a
     * component to that. Of several set, the first in this order gives the size, as in the
     * pseudo-code of the specification and in fontforge 20230101.
     */
    private transformSizeBytes(flags: number): number {
        if ((flags & SfntFontValidator.WE_HAVE_A_SCALE) !== 0) {
            return SfntFontValidator.SCALE_SIZE_BYTES;
        }

        if ((flags & SfntFontValidator.WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
            return SfntFontValidator.X_AND_Y_SCALE_SIZE_BYTES;
        }

        if ((flags & SfntFontValidator.WE_HAVE_A_TWO_BY_TWO) !== 0) {
            return SfntFontValidator.TWO_BY_TWO_SIZE_BYTES;
        }

        return SfntFontValidator.NO_TRANSFORM_SIZE_BYTES;
    }

    /**
     * `startBytes` is where the last component ends, counted from the start of the glyph.
     */
    private checkCompositeInstructions(fontPath: string, view: DataView, glyph: GlyfEntry, startBytes: number): void {
        const numInstrEndBytes = startBytes + SfntFontValidator.NUM_INSTR_SIZE_BYTES;

        this.checkInGlyph(fontPath, glyph, SfntRule.CompositeGlyphInData, numInstrEndBytes, "numInstr");

        const numInstr = view.getUint16(glyph.offsetBytes + startBytes);

        this.checkInGlyph(fontPath, glyph, SfntRule.CompositeGlyphInData, numInstrEndBytes + numInstr, `instructions[${numInstr}]`);
    }

    /**
     * Follows the components of every composite glyph down to the glyphs without components. A
     * glyph met again on the chain that leads to it closes a cycle; a glyph whose components are all
     * followed already is not followed again, so the walk takes each component once below a root,
     * and a root walked already costs only a look at its own components.
     */
    private checkComponentCycles(fontPath: string, componentsByGlyph: ReadonlyMap<number, ReadonlyArray<number>>): void {
        const walkedGlyphIds = new Set<number>();

        for (const [glyphId, componentGlyphIds] of componentsByGlyph) {
            this.walkComponents(
                fontPath,
                componentsByGlyph,
                { glyphId: glyphId, componentGlyphIds: componentGlyphIds, nextComponentIndex: 0 },
                walkedGlyphIds,
            );
        }
    }

    /**
     * Depth first with a stack of its own rather than by recursion: a crafted font can chain 65 535
     * composite glyphs, one inside the next, deeper than the call stack goes. For the same chain the
     * glyphs on it are kept in a set as well, so that a step does not search the stack.
     */
    private walkComponents(
        fontPath: string,
        componentsByGlyph: ReadonlyMap<number, ReadonlyArray<number>>,
        root: ComponentWalk,
        walkedGlyphIds: Set<number>,
    ): void {
        const chain = [root];
        const chainGlyphIds = new Set([root.glyphId]);
        // The top of the chain: the glyph whose components are being followed.
        let current: ComponentWalk | undefined = root;

        while (current !== undefined) {
            const componentGlyphId = current.componentGlyphIds[current.nextComponentIndex];

            // Every component of the glyph is followed.
            if (componentGlyphId === undefined) {
                chain.pop();
                chainGlyphIds.delete(current.glyphId);
                walkedGlyphIds.add(current.glyphId);
                current = chain[chain.length - 1];
                continue;
            }

            current.nextComponentIndex++;

            if (chainGlyphIds.has(componentGlyphId)) {
                this.throwCycle(fontPath, chain, componentGlyphId);
            }

            const components = componentsByGlyph.get(componentGlyphId);

            if (components !== undefined && !walkedGlyphIds.has(componentGlyphId)) {
                current = { glyphId: componentGlyphId, componentGlyphIds: components, nextComponentIndex: 0 };
                chain.push(current);
                chainGlyphIds.add(componentGlyphId);
            }
        }
    }

    /**
     * The message lists the cycle from the glyph that closes it, which is on `chain`, round to that
     * glyph again.
     */
    private throwCycle(fontPath: string, chain: ReadonlyArray<ComponentWalk>, closingGlyphId: number): never {
        const cycleStart = chain.findIndex((link) => link.glyphId === closingGlyphId);
        const cycleGlyphIds = [...chain.slice(cycleStart).map((link) => link.glyphId), closingGlyphId];

        throw BrokenSfnt.byRule(fontPath, {
            rule: SfntRule.ComponentCycle,
            at: this.tableName(SfntFontValidator.GLYF_TAG),
            field: `the chain of components from glyph ${closingGlyphId}`,
            value: cycleGlyphIds.join(" -> "),
            expected: "a chain that ends at glyphs without components",
        });
    }

    /**
     * `fields` names what ends at `endBytes`, counted from the start of the glyph, and `rule` is the
     * rule of a simple or of a composite glyph.
     */
    private checkInGlyph(fontPath: string, glyph: GlyfEntry, rule: SfntRule, endBytes: number, fields: string): void {
        if (endBytes > glyph.lengthBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: rule,
                at: this.tableName(SfntFontValidator.GLYF_TAG),
                field: `the end of ${fields} of glyph ${glyph.id}`,
                value: endBytes,
                expected: `at most ${glyph.lengthBytes}, the length of glyph ${glyph.id} by loca`,
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
        const layout = SfntFontValidator.CMAP_SUBTABLE_LAYOUTS.get(format);
        const at = this.tableName(SfntFontValidator.CMAP_TAG);

        if (layout === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableFormat,
                at: at,
                field: `the format of the subtable of encodingRecords[${index}]`,
                value: format,
                expected: this.oneOf([...SfntFontValidator.CMAP_SUBTABLE_LAYOUTS.keys()]),
            });
        }

        const lengthField = layout.lengthField;
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
        const lengthFieldLabel = `the length of the subtable of encodingRecords[${index}]`;

        // Past cmap fontforge reads the bytes of the next table, or of no table: of 20 variants of the
        // fixtures with such a subtable at the end of cmap it lost every encoding in 15, made one up
        // in 3 and ran past 60 s in 2. A length short of that part loses nothing while the part
        // itself lies inside cmap; the rule follows the standard there.
        if (subtableLengthBytes < layout.fixedSizeBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableMinLength,
                at: at,
                field: lengthFieldLabel,
                value: subtableLengthBytes,
                expected: `at least ${layout.fixedSizeBytes}, the part of format ${format} of a set size`,
            });
        }

        const restBytes = cmap.length - subtableOffset;

        if (subtableLengthBytes > restBytes) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.CmapSubtableLength,
                at: at,
                field: lengthFieldLabel,
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
    private checkPost(fontPath: string, view: DataView, post: SfntTableRecord, maxpNumGlyphs: number): void {
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

        // Fewer names than glyphs: fontforge renames the glyphs past them that have no encoding to
        // glyphN, 401 of the TrueType fixture with numGlyphs 0.
        if (numGlyphs < maxpNumGlyphs) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.PostNumGlyphs,
                at: this.tableName(SfntFontValidator.POST_TAG),
                field: "numGlyphs",
                value: numGlyphs,
                expected: `at least ${maxpNumGlyphs}, maxp.numGlyphs`,
            });
        }

        const entriesEndBytes = numGlyphsEndBytes + numGlyphs * glyphNames.entrySizeBytes;

        this.checkLength(
            fontPath,
            post,
            SfntRule.PostLength,
            entriesEndBytes,
            `the header, numGlyphs and ${glyphNames.entries}[${numGlyphs}]`,
        );

        if (glyphNames.hasNameStrings) {
            this.checkPostStrings(fontPath, view, post, numGlyphs, numGlyphsEndBytes, entriesEndBytes);
        }
    }

    /**
     * Walks the Pascal strings up to the last one an index points at; the strings past it are not
     * read. fontforge 20230101 renames a glyph whose string is missing to glyphN and cuts the name
     * of one whose string is cut short; reading past the end of the file, it puts a 0xFF byte into
     * the name, and the output carries it.
     */
    private checkPostStrings(
        fontPath: string,
        view: DataView,
        post: SfntTableRecord,
        postNumGlyphs: number,
        indexStartBytes: number,
        stringsStartBytes: number,
    ): void {
        // Of glyphs sharing the highest index, the message names the first.
        let glyphWithHighestIndex = 0;
        let highestIndex = 0;

        for (let glyphIndex = 0; glyphIndex < postNumGlyphs; glyphIndex++) {
            const glyphNameIndex = view.getUint16(
                post.offset + indexStartBytes + glyphIndex * SfntFontValidator.GLYPH_NAME_INDEX_SIZE_BYTES,
            );

            if (glyphNameIndex > highestIndex) {
                glyphWithHighestIndex = glyphIndex;
                highestIndex = glyphNameIndex;
            }
        }

        // Every glyph takes a standard name: no string is read.
        if (highestIndex < SfntFontValidator.POST_STANDARD_NAME_COUNT) {
            return;
        }

        const stringCount = highestIndex - SfntFontValidator.POST_STANDARD_NAME_COUNT + 1;
        const at = this.tableName(SfntFontValidator.POST_TAG);
        let stringOffsetBytes = stringsStartBytes;

        for (let stringIndex = 0; stringIndex < stringCount; stringIndex++) {
            const lengthEndBytes = stringOffsetBytes + SfntFontValidator.PASCAL_STRING_LENGTH_SIZE_BYTES;
            // A string whose length byte lies past the table ends, for the message, with that byte.
            let stringEndBytes = lengthEndBytes;

            if (lengthEndBytes <= post.length) {
                stringEndBytes += view.getUint8(post.offset + stringOffsetBytes);
            }

            if (stringEndBytes > post.length) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.PostNameStringInTable,
                    at: at,
                    field: `the end of string ${stringIndex} of stringData`,
                    value: stringEndBytes,
                    expected: `at most ${post.length}, the length of ${at}, as glyphNameIndex[${glyphWithHighestIndex}] is ${highestIndex}`,
                });
            }

            stringOffsetBytes = stringEndBytes;
        }
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
