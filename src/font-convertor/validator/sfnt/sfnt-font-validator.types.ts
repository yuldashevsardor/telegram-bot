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
}

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
