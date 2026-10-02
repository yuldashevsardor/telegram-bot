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
    GlyphHeader = "a glyph with an outline holds the 10-byte glyph header: its length by loca, loca[n+1] - loca[n], is 0 or at least 10 (OpenType 1.9.1, glyf, Glyph Headers)",
    SimpleGlyphInData = "a simple glyph, of numberOfContours 0 or more, lies inside its length by loca: endPtsOfContours[numberOfContours], instructionLength, the instructions, the flags with their repeat counts, and the x and y coordinates of the widths its flags give (OpenType 1.9.1, glyf, Simple Glyph Description)",
    EndPtsAscending = "the endPtsOfContours of a simple glyph are in increasing numeric order (OpenType 1.9.1, glyf, Simple Glyph Description)",
    FlagPerPoint = "a simple glyph has one flag per point: its flags, each with its repeats, are no more than endPtsOfContours[numberOfContours - 1] + 1 (OpenType 1.9.1, glyf, Simple Glyph Description)",
    CompositeGlyphInData = "a composite glyph, of a negative numberOfContours, lies inside its length by loca: at least one component, each with its flags and glyphIndex, its arguments of 4 bytes with ARG_1_AND_2_ARE_WORDS and of 2 without, and its transform of 2, 4 or 8 bytes with WE_HAVE_A_SCALE, WE_HAVE_AN_X_AND_Y_SCALE or WE_HAVE_A_TWO_BY_TWO, and after the last component, when any of them sets WE_HAVE_INSTRUCTIONS, numInstr and the instructions (OpenType 1.9.1, glyf, Composite Glyph Description)",
    ComponentGlyphIndex = "the glyphIndex of a component is less than maxp.numGlyphs (OpenType 1.9.1, glyf, Composite Glyph Description; maxp)",
    ComponentCycle = "the components of composite glyphs make no cycle, a glyph that is its own component included: the graph they make must be acyclic (OpenType 1.9.1, glyf, Composite Glyph Description)",
    CmapRecordsInTable = "cmap holds its 4-byte header and an 8-byte encoding record per numTables (OpenType 1.9.1, cmap)",
    CmapVersion = "cmap.version is 0 (OpenType 1.9.1, cmap)",
    CmapSubtables = "cmap has at least one subtable (ours: the specification sets no count, and without a subtable fontforge 20230101 drops the encoding)",
    CmapSubtableInTable = "a cmap subtable starts after the header and the encoding records of cmap, with room in cmap for its format and for the fields up to its length: 4 bytes for formats 0 to 6, 8 for 8 to 13 and 6 for 14, as the length of a table encompasses its subtables (OpenType 1.9.1, Table Directory; cmap)",
    CmapSubtableFormat = "a cmap subtable is of format 0, 2, 4, 6, 8, 10, 12, 13 or 14 (OpenType 1.9.1, cmap)",
    CmapSubtableMinLength = "a cmap subtable is at least as long as the part of its format of a set size, the fields and arrays before its first array of a variable count: 262 bytes for format 0, 518 for 2, 14 for 4, 10 for 6 and 14, 8208 for 8, 20 for 10, and 16 for 12 and 13 (OpenType 1.9.1, cmap)",
    CmapSubtableLength = "a cmap subtable ends inside cmap: its offset plus its length is at most the length of cmap (OpenType 1.9.1, Table Directory; cmap)",
    NameRecordsInTable = "name holds its 6-byte header and a 12-byte name record per count, and with version 1 a 2-byte langTagCount and a 4-byte language-tag record per langTagCount (OpenType 1.9.1, name)",
    NameStorageAfterRecords = "the string storage of name starts after its records: storageOffset is at least where the name records, and with version 1 the language-tag records, end (OpenType 1.9.1, name)",
    NameStringInTable = "every non-empty string of name, of a name record and of a language-tag record, lies inside name: storageOffset plus its offset plus its length is at most the length of name (OpenType 1.9.1, name; Table Directory)",
    NameVersion = "name.version is 0 or 1 (OpenType 1.9.1, name)",
    Os2Version = "OS/2.version is from 0 to 5 (OpenType 1.9.1, OS/2)",
    Os2Length = "OS/2 holds its 2-byte version and the fields of that version: 86 bytes for version 1, 96 for 2 to 4, 100 for 5, and 68 for version 0, whose last five fields a legacy font may lack (OpenType 1.9.1, OS/2)",
    PostLength = "post holds its 32-byte header, and with version 2.0 a 2-byte numGlyphs and a 2-byte glyphNameIndex per numGlyphs, with version 2.5 a 2-byte numGlyphs and a 1-byte offset per numGlyphs (OpenType 1.9.1, post)",
    PostVersion = "post.version is 1.0, 2.0, 2.5 or 3.0 (OpenType 1.9.1, post)",
    PostNumGlyphs = "post.numGlyphs of version 2.0 or 2.5 is at least maxp.numGlyphs (ours: OpenType 1.9.1, post, says only that the two should be the same; with fewer, fontforge 20230101 renames the glyphs past them, and with more it loses nothing)",
    PostNameStringInTable = "every glyph name of post 2.0 that a glyphNameIndex of 258 or more points at lies inside post, with the Pascal strings before it (OpenType 1.9.1, post; Table Directory)",
}

/**
 * The tables the rules on the content read, found by the rules on the table directory.
 * `trueTypeOutlines` is undefined in a font with CFF outlines, whatever else it holds: a `glyf` or
 * a `loca` next to `CFF ` is not read as outlines. `os2` is undefined in a font with TrueType
 * outlines that lacks the table.
 */
export type SfntTables = {
    cmap: SfntTableRecord;
    head: SfntTableRecord;
    hhea: SfntTableRecord;
    hmtx: SfntTableRecord;
    maxp: SfntTableRecord;
    name: SfntTableRecord;
    os2: SfntTableRecord | undefined;
    post: SfntTableRecord;
    trueTypeOutlines: TrueTypeOutlines | undefined;
};

export type TrueTypeOutlines = {
    glyf: SfntTableRecord;
    loca: SfntTableRecord;
};

/**
 * Where the data of a glyph with an outline lies in glyf: `offsetBytes` is where it starts in the
 * file, `lengthBytes` its length by loca.
 */
export type GlyfEntry = {
    id: number;
    offsetBytes: number;
    lengthBytes: number;
};

/**
 * A composite glyph on the chain of components being followed: the glyphs its components point at,
 * and the index in them of the next one to follow.
 */
export type ComponentWalk = {
    glyphId: number;
    componentGlyphIds: ReadonlyArray<number>;
    nextComponentIndex: number;
};

/**
 * The bits of a simple glyph flag that give the width of one coordinate: `shortVector`, 1 byte;
 * else `sameOrPositive`, no byte, the coordinate is the previous one; else 2 bytes.
 */
export type CoordinateFlagBits = {
    shortVector: number;
    sameOrPositive: number;
};

/**
 * What the flags of a simple glyph lay out: where they end, from the start of the glyph, and how
 * many bytes the x and the y coordinates that follow them take.
 */
export type FlagsLayout = {
    flagsEndBytes: number;
    xCoordinatesSizeBytes: number;
    yCoordinatesSizeBytes: number;
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
 * Where a cmap subtable of one format gives its length, from the start of the subtable, and how wide
 * the field is. Every format opens with a 2-byte format field.
 */
export type CmapSubtableLengthField = {
    offsetBytes: number;
    sizeBytes: number;
};

/**
 * What the validator knows of a cmap subtable format: where its length lies, and how long the part
 * of a set size is, the fields and arrays before the first array of a variable count. Format 0 has
 * no such array, so the part is the whole subtable.
 */
export type CmapSubtableLayout = {
    lengthField: CmapSubtableLengthField;
    fixedSizeBytes: number;
};

/**
 * A kind of record of name that points at a string in the string storage: the name record or the
 * language-tag record. `label` names the record array in the messages.
 */
export type NameStringRecord = {
    label: string;
    sizeBytes: number;
    lengthOffsetBytes: number;
    stringOffsetOffsetBytes: number;
};

/**
 * `count` records of one kind, starting at `startBytes` from the start of name.
 */
export type NameRecordArray = {
    record: NameStringRecord;
    startBytes: number;
    count: number;
};

/**
 * What a version of post holds past its 32-byte header: a numGlyphs and one entry per glyph.
 * `entries` names the entry array in the messages. `hasNameStrings` says whether glyph names of the
 * table's own, Pascal strings, follow the entries.
 */
export type PostGlyphNames = {
    entries: string;
    entrySizeBytes: number;
    hasNameStrings: boolean;
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
