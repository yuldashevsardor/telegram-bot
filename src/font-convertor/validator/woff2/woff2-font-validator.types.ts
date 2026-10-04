/**
 * A rule a WOFF2 file breaks. The text names the rule and where it comes from: a section of W3C
 * Recommendation "WOFF File Format 2.0", of "WOFF File Format 1.0" where WOFF 2.0 takes the rule
 * over from it, the W3C test suite, or ours, where the domain asks more than the standard.
 */
export enum Woff2Rule {
    Length = "length is the file size (WOFF 2.0, §3.2; WOFF 1.0, §4)",
    TablesPresent = "numTables is not 0 (the W3C test suite of WOFF 2.0, header-numTables-001)",
    DirectoryInFile = "the file holds the header and the whole table directory (WOFF 2.0, §3, §4.1)",
    UIntBase128 = "a UIntBase128 does not start with 0x80, takes at most 5 bytes and is at most 4294967295 (WOFF 2.0, §3.1)",
    TransformVersion = "the transform version is defined for the table: 0 or 3 for glyf and loca, 0 or 1 for hmtx, 0 for any other table (WOFF 2.0, §4.1, §5)",
    SingleEntry = "the table directory holds a single entry for each table (WOFF 2.0, §4)",
    GlyfLoca = "glyf and loca are both present or both absent, both transformed or both not, and loca follows glyf in the table directory (WOFF 2.0, §5.3, §5.5)",
    LocaTransform = "a transformed loca has transformLength 0 and origLength (numGlyphs + 1) × 2 when indexFormat of the transformed glyf is 0, × 4 otherwise (WOFF 2.0, §5.3)",
    HmtxTransform = "a transformed hmtx is in a font with glyf, and its flags byte has bit 0 or bit 1 set and bits 2–7 zero (WOFF 2.0, §5.4)",
    BlockAbsence = "an absent metadata or private block has offset and length 0, and absent metadata has metaOrigLength 0 (WOFF 2.0, §3.2; WOFF 1.0, §4)",
    BlockInFile = "neither the compressed data nor the metadata or private block runs past the end of the file (WOFF 2.0, §3)",
    BlockAlignment = "the metadata and the private block start on a 4-byte boundary (WOFF 2.0, §6, §7)",
    NoOverlap = "no two blocks overlap, nor a block and the table directory (WOFF 2.0, §3)",
    NoExtraneousData = "the compressed data follows the table directory, then the metadata, then the private block, which ends the file; nothing lies between or after them but padding, and no padding follows the metadata when it is last (WOFF 2.0, §3, §6, §7)",
    Padding = "padding is 0 to 3 null bytes (WOFF 2.0, §3)",
    Brotli = "the compressed data is one Brotli stream that decompresses to the sum of origLength of the plain tables and transformLength of the transformed ones (WOFF 2.0, §5)",
    TransformedGlyf = "the transformed glyf holds its 36-byte header and its seven substreams, bboxStream starts with its bboxBitmap, and the overlapSimpleBitmap follows the substreams when bit 0 of optionFlags is set (WOFF 2.0, §5.1)",
    GlyphStreams = "each substream of the transformed glyf holds what its glyph records take from it (WOFF 2.0, §5.1, §5.2)",
    ContourCount = "nContour of a glyph is -1 for a composite glyph, 0 for an empty one or positive for a simple one (WOFF 2.0, §5.1)",
    CompositeBoundingBox = "a composite glyph has an explicit bounding box (WOFF 2.0, §5.1)",
    EmptyGlyphBoundingBox = "an empty glyph has no explicit bounding box (WOFF 2.0, §5.1)",
    EndPoint = "the end point of a contour is at most 65535, as endPtsOfContours of glyf is a uint16 (WOFF 2.0, §5.1; OpenType 1.9.1, glyf)",
    TransformedHmtx = "a transformed hmtx holds advanceWidth[] for numberOfHMetrics of hhea, then lsb[] and leftSideBearing[] unless its flags drop them, and numberOfHMetrics is 1 to numGlyphs of the transformed glyf (WOFF 2.0, §5.4; OpenType 1.9.1, hmtx)",
    Flavor = "flavor is an sfnt version the domain accepts (ours: a collection holds several fonts, and fontforge refuses any other flavor)",
    HmtxBesideTransformedGlyf = "a transformed hmtx is in a font whose glyf is transformed (ours: the decoder of fontforge takes the glyph count and the xMin of the glyphs from the transformed glyf alone)",
    EndPadding = "the compressed data that ends the file is padded to a 4-byte boundary (ours: the decoder of fontforge refuses a file that ends before it)",
    MaxDecompressedSize = "the tables decompress to at most 30 MiB (ours: the output buffer fontforge gives its decoder)",
    MaxCompressionRatio = "the tables decompress to at most 100 times the file size (ours: the decoder of fontforge refuses a higher ratio)",
    MaxSfntSize = "the rebuilt sfnt is at most 30 MiB (ours: the output buffer fontforge gives its decoder)",
}

/**
 * The tags of the tables the rules name.
 */
export enum TableTag {
    Glyf = "glyf",
    Loca = "loca",
    Hmtx = "hmtx",
    Hhea = "hhea",
}

/**
 * A broken rule: what `BrokenWoff2` is built from.
 */
export type Violation = {
    rule: Woff2Rule;
    /** Where the rule is broken: the header, the file, the table directory, a directory entry, a table by its tag, a block. */
    at: string;
    /** The field or the property that breaks the rule. */
    field: string;
    value: number | string;
    expected: string;
};

/**
 * The header fields the validator checks. The signature is checked before the header is read.
 * reserved and totalSfntSize are deliberately not read (see the class comment of
 * `Woff2FontValidator`), and majorVersion and minorVersion have no rule.
 */
export type Woff2Header = {
    flavor: number;
    length: number;
    numTables: number;
    totalCompressedSize: number;
    metaOffset: number;
    metaLength: number;
    metaOrigLength: number;
    privOffset: number;
    privLength: number;
};

/**
 * A table directory entry (§4.1). The tag is read as four Latin-1 characters. transformLength is
 * there exactly when the table is transformed: the transform version decides whether the entry
 * carries the field at all.
 */
export type TableEntry = {
    tag: string;
    transformVersion: number;
    origLength: number;
    transformLength: number | undefined;
};

/**
 * The transform versions defined for a table (§4.1, §5): the one that is a transform, if the table
 * has one, and the null transform.
 */
export type TransformVersions = {
    transformed?: number;
    plain: number;
};

/**
 * A table of the directory with its bytes cut from the decompressed stream: transformLength bytes
 * when it is transformed, origLength otherwise.
 */
export type DecompressedTable = {
    entry: TableEntry;
    bytes: Uint8Array;
};

/**
 * A table of the sfnt the WOFF2 rebuilds: a plain table as it is in the decompressed stream, a
 * transformed one as `GlyfReconstructor` rebuilds it.
 */
export type SfntTable = {
    tag: string;
    bytes: Uint8Array;
};

/**
 * The kinds of block after the table directory, in the order §3 lays them out in the file.
 */
export enum BlockKind {
    CompressedData,
    Metadata,
    Private,
}

/**
 * A byte range of the file: the compressed data, the metadata or the private block.
 */
export type Block = {
    kind: BlockKind;
    /** How a message names the block: `the compressed data`, `the metadata block`. */
    name: string;
    offset: number;
    length: number;
};

/**
 * What a gap between blocks ends at: the next block, or the end of the file.
 */
export type GapEnd = {
    /** How a message names it: `the file`, `the private block`. */
    at: string;
    /** The field whose value is the end: `offset` of a block, `size` of the file. */
    field: string;
    offset: number;
};

/**
 * Where a gap is to end: the end of the block before it, padded or not.
 */
export type ExpectedEnd = {
    offset: number;
    /** What the offset is, for a message: `the end of the metadata block padded to 4 bytes`. */
    description: string;
};

/**
 * A file that passed the signature, with its header and table directory read.
 */
export type Woff2 = {
    path: string;
    bytes: Uint8Array;
    header: Woff2Header;
    entries: Array<TableEntry>;
    directoryEnd: number;
};
