/**
 * A rule a WOFF file breaks. The text names the rule and where it comes from: a section of W3C
 * Recommendation "WOFF File Format 1.0", or ours, where the domain asks more than the standard.
 */
export enum WoffRule {
    DirectoryInFile = "the file holds the header and the whole table directory (WOFF 1.0, §3, §4, §5)",
    Length = "length is the file size (WOFF 1.0, §4)",
    Reserved = "reserved is 0 (WOFF 1.0, §4)",
    TablesPresent = "numTables is not 0 (WOFF 1.0, §4)",
    TotalSfntSize = "totalSfntSize is 12 + 16 × numTables + the origLength of every table padded to 4 bytes (WOFF 1.0, §4)",
    BlockAbsence = "an absent metadata or private block has offset and length 0, and absent metadata has metaOrigLength 0 (WOFF 1.0, §4)",
    AscendingTags = "the table directory lists the tags in ascending order, each once (WOFF 1.0, §5)",
    TableAlignment = "a table starts on a 4-byte boundary (WOFF 1.0, §5)",
    Padding = "a table is padded to a 4-byte boundary with 0 to 3 zero bytes, the last one too (WOFF 1.0, §3, §5)",
    BlockInFile = "no table, metadata or private block runs past the end of the file (WOFF 1.0, §3, §4, §5)",
    NoOverlap = "no two blocks overlap, nor a block and the table directory (WOFF 1.0, §3, §4, §5)",
    NoExtraneousData = "the tables follow the table directory in one run, then the metadata, then the private block, which ends the file; nothing lies between or after them but padding, and no padding follows the metadata when it is last (WOFF 1.0, §3, §6, §7, §8)",
    PrivateAlignment = "the private block starts on a 4-byte boundary (WOFF 1.0, §8)",
    CompressedLength = "compLength is not greater than origLength (WOFF 1.0, §5)",
    Zlib = "a table with compLength less than origLength is one zlib stream that inflates to origLength bytes (WOFF 1.0, §5, §6)",
    TableChecksum = "origChecksum is the checksum of the uncompressed table, of head with checkSumAdjustment as 0 (WOFF 1.0, §5)",
    Flavor = "flavor is an sfnt version the domain accepts (ours: fontforge refuses any other, and a collection holds several fonts)",
    MaxSfntSize = "totalSfntSize is at most 32 MiB (ours: every table is inflated in the bot's process, and the largest of 5405 real fonts unpacks to 2.9 MB)",
}

/**
 * A broken rule: what `BrokenWoff` is built from.
 */
export type Violation = {
    rule: WoffRule;
    /** Where the rule is broken: the header, the file, the table directory, a table by its tag, the metadata or the private block. */
    at: string;
    /** The field or the property that breaks the rule. */
    field: string;
    value: number | string;
    expected: string;
};

/**
 * The header fields the validator checks. The signature is checked before the header is read,
 * and majorVersion and minorVersion have no rule (§4).
 */
export type WoffHeader = {
    flavor: number;
    length: number;
    numTables: number;
    reserved: number;
    totalSfntSize: number;
    metaOffset: number;
    metaLength: number;
    metaOrigLength: number;
    privOffset: number;
    privLength: number;
};

/**
 * A table directory entry (§5). The tag is read as four Latin-1 characters, so comparing two tags
 * as strings compares them as the unsigned numbers of their bytes.
 */
export type TableEntry = {
    tag: string;
    offset: number;
    compLength: number;
    origLength: number;
    origChecksum: number;
};

/**
 * The kinds of block, in the order §3 lays them out in the file.
 */
export enum BlockKind {
    Directory,
    Table,
    Metadata,
    Private,
}

/**
 * A byte range of the file that the header or the table directory points to; the header with the
 * directory is one too.
 */
export type Block = {
    kind: BlockKind;
    /** How a message names the block: `the metadata block`, `table "cmap"`. */
    name: string;
    offset: number;
    length: number;
};

/**
 * A file that passed the signature, with its header and table directory read.
 */
export type Woff = {
    path: string;
    bytes: Uint8Array;
    header: WoffHeader;
    entries: Array<TableEntry>;
};
