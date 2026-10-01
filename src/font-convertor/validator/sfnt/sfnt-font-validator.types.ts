import type { SfntTableRecord } from "app/font-convertor/sfnt-table-directory/sfnt-table-directory.types";

/**
 * A rule an sfnt font breaks. The text names the rule and where it comes from: a section of the
 * Microsoft OpenType specification 1.9.1, a chapter of Apple's TrueType Reference Manual for what it
 * governs, or ours, where the domain asks more than the standard.
 */
export enum SfntRule {
    Collection = "the file is one font, not a collection (ours: a collection holds several fonts, and which of them to take is not the domain's call)",
    TablesPresent = "numTables is not 0 (OpenType 1.9.1, Required Tables)",
    DirectoryInFile = "the file holds the 12-byte header and a 16-byte table record per table (OpenType 1.9.1, Table Directory)",
    AscendingTags = "the table records are sorted in ascending order by tag, each tag once (OpenType 1.9.1, Table Directory)",
    TableInFile = "a table lies inside the file: offset + length is at most the file size (OpenType 1.9.1, Table Directory)",
    RequiredTable = "the font has cmap, head, hhea, hmtx, maxp, name and post (OpenType 1.9.1, Required Tables; TrueType Reference Manual, chapter 6)",
    NoCff2 = "the outlines are not CFF2 (ours: fontforge 20230101 does not open a font with them)",
    Outlines = "the font has TrueType outlines, glyf with loca, or CFF outlines, CFF (OpenType 1.9.1, Required Tables)",
    Os2WithCff = "a font with CFF outlines has OS/2 (OpenType 1.9.1, Required Tables; a font with TrueType outlines may lack it, TrueType Reference Manual, chapter 6)",
    HeadLength = "head is at least 54 bytes long (OpenType 1.9.1, head)",
    HeadVersion = "head.majorVersion is 1 (OpenType 1.9.1, head)",
    MagicNumber = "head.magicNumber is 0x5F0F3CF5 (OpenType 1.9.1, head)",
    UnitsPerEm = "head.unitsPerEm is from 16 to 16384 (OpenType 1.9.1, head)",
    IndexToLocFormat = "head.indexToLocFormat is 0 for short loca offsets or 1 for long ones (OpenType 1.9.1, head)",
    MaxpVersion = "maxp is version 0.5, at least 6 bytes long, with CFF outlines, and version 1.0, at least 32 bytes long, with TrueType outlines (OpenType 1.9.1, maxp)",
    NotdefGlyph = "maxp.numGlyphs is at least 1: glyph 0 must be the .notdef glyph (OpenType 1.9.1, Recommendations for OpenType Fonts, Glyph 0)",
    HheaLength = "hhea is at least 36 bytes long (OpenType 1.9.1, hhea)",
    NumberOfHMetrics = "hhea.numberOfHMetrics is from 1 to maxp.numGlyphs: the last of the hmtx records applies to the remaining glyphs (OpenType 1.9.1, hmtx)",
    HmtxLength = "hmtx holds a 4-byte record per numberOfHMetrics and a 2-byte left side bearing per remaining glyph (OpenType 1.9.1, hmtx)",
    LocaLength = "loca holds numGlyphs + 1 offsets, 2 bytes each with indexToLocFormat 0 and 4 bytes with 1 (OpenType 1.9.1, loca)",
    LocaAscending = "the loca offsets are in ascending order, loca[n] <= loca[n+1] (OpenType 1.9.1, loca)",
    LocaInGlyf = "the last loca offset, the end of the last glyph, lies within glyf (OpenType 1.9.1, loca)",
}

/**
 * The tables every font must have and its TrueType outlines, found by the rules on the table
 * directory; the rules on the content read them. `trueTypeOutlines` is undefined in a font with CFF
 * outlines, whatever else it holds: a `glyf` or a `loca` next to `CFF ` is not read as outlines.
 */
export type SfntTables = {
    cmap: SfntTableRecord;
    head: SfntTableRecord;
    hhea: SfntTableRecord;
    hmtx: SfntTableRecord;
    maxp: SfntTableRecord;
    name: SfntTableRecord;
    post: SfntTableRecord;
    trueTypeOutlines: TrueTypeOutlines | undefined;
};

export type TrueTypeOutlines = {
    glyf: SfntTableRecord;
    loca: SfntTableRecord;
};

/**
 * What `maxp` must be with the outlines of the font: its version and the length that version needs.
 */
export type MaxpExpectation = {
    version: number;
    minLengthBytes: number;
    /** The outline table that decides the version, for the message. */
    outlinesTag: string;
};

/**
 * How `head.indexToLocFormat` lays out a loca offset: its width, and the factor that turns the
 * stored value into bytes (the short format stores the offset divided by 2).
 */
export type LocaFormat = {
    entrySizeBytes: number;
    offsetFactor: number;
};

/**
 * A broken rule: what `BrokenSfnt` is built from.
 */
export type Violation = {
    rule: SfntRule;
    /** Where the rule is broken: the header, the file, the table directory or a table by its tag. */
    at: string;
    /** The field or the property that breaks the rule. */
    field: string;
    value: number | string;
    expected: string;
};
