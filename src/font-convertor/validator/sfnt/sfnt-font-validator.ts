import { injectable } from "inversify";
import { SfntTableDirectory } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory";
import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";
import { SFNT_VERSIONS } from "app/font-convertor/sfnt-version";
import { BrokenSfnt, NotSfnt } from "app/font-convertor/validator/sfnt/sfnt-font-validator.errors";
import { SfntRule } from "app/font-convertor/validator/sfnt/sfnt-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";
import { FileHelper } from "app/shared/fs/file-helper";

/**
 * Checks a TTF or OTF font against the Microsoft OpenType specification 1.9.1, and against Apple's
 * TrueType Reference Manual for what it governs: the table directory and the tables a font must
 * have. Both extensions take the same checks: the sfnt version names the outline type, not the
 * extension, and the rules that depend on the outline type go by the outline tables present, not
 * by the version, which the specification only says "should" match them.
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
    private static readonly VERSION_OFFSET = 0;
    private static readonly NUM_TABLES_OFFSET = 4;
    private static readonly COLLECTION_VERSION = 0x74746366;
    // In the order the rule lists them, which is the order they are reported in.
    private static readonly REQUIRED_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "post"];
    private static readonly OUTLINES_EXPECTED = '"glyf" with "loca", or "CFF "';

    /**
     * Throws when the file is not a valid sfnt font. The answers are subclasses of
     * `InvalidSfntFont`: `NotSfnt` for a file shorter than the header or of an unknown version,
     * `BrokenSfnt` for the first broken rule, checked in this order: the header, the table records
     * one by one in directory order, then the tables the font has. A file that cannot be read throws
     * `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);

        this.checkHeader(fontPath, bytes);

        const directory = new SfntTableDirectory(bytes);

        this.checkRecords(fontPath, directory.records(), bytes.length);
        this.checkTables(fontPath, directory);
    }

    /**
     * The header is read here, before `SfntTableDirectory` parses the same bytes: the directory
     * rejects a short file or an unknown version with the codec's `InvalidSfnt`, while an answer
     * of the validator names the rule broken. Past these checks the directory cannot throw.
     */
    private checkHeader(fontPath: string, bytes: Uint8Array): void {
        const headerSizeBytes = SfntTableDirectory.HEADER_SIZE_BYTES;

        if (bytes.length < headerSizeBytes) {
            throw NotSfnt.bySize(fontPath, bytes.length, headerSizeBytes);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const version = view.getUint32(SfntFontValidator.VERSION_OFFSET);
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

        const numTables = view.getUint16(SfntFontValidator.NUM_TABLES_OFFSET);

        if (numTables === 0) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.TablesPresent,
                at: at,
                field: "numTables",
                value: numTables,
                expected: "at least 1",
            });
        }

        const directoryEnd = headerSizeBytes + numTables * SfntTableDirectory.RECORD_SIZE_BYTES;

        if (bytes.length < directoryEnd) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.DirectoryInFile,
                at: "the file",
                field: "size",
                value: bytes.length,
                expected: `at least ${directoryEnd} for ${numTables} table records`,
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

            const tableEnd = record.offset + record.length;

            if (tableEnd > fileSizeBytes) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.TableInFile,
                    at: this.tableName(record.tag),
                    field: "offset + length",
                    value: tableEnd,
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
    private checkTables(fontPath: string, directory: SfntTableDirectory): void {
        const at = "the table directory";

        for (const tag of SfntFontValidator.REQUIRED_TAGS) {
            if (directory.find(tag) === undefined) {
                throw BrokenSfnt.byRule(fontPath, {
                    rule: SfntRule.RequiredTable,
                    at: at,
                    field: this.tableName(tag),
                    value: "absent",
                    expected: "present",
                });
            }
        }

        if (directory.find("CFF2") !== undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.NoCff2,
                at: at,
                field: this.tableName("CFF2"),
                value: "present",
                expected: "absent",
            });
        }

        const hasGlyf = directory.find("glyf") !== undefined;
        const hasLoca = directory.find("loca") !== undefined;
        const hasCff = directory.find("CFF ") !== undefined;

        if (hasGlyf !== hasLoca) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: hasGlyf ? '"glyf" without "loca"' : '"loca" without "glyf"',
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        if (!hasGlyf && !hasCff) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Outlines,
                at: at,
                field: "outlines",
                value: "none",
                expected: SfntFontValidator.OUTLINES_EXPECTED,
            });
        }

        if (hasCff && directory.find("OS/2") === undefined) {
            throw BrokenSfnt.byRule(fontPath, {
                rule: SfntRule.Os2WithCff,
                at: at,
                field: this.tableName("OS/2"),
                value: "absent",
                expected: 'present, as the font has "CFF "',
            });
        }
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
