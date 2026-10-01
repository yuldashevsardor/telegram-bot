import type { EotBlock } from "app/font-convertor/eot-header/eot-header.types";

/**
 * A rule an EOT file breaks. The text names the rule and where it comes from: a section of W3C
 * Member Submission "Embedded OpenType (EOT) File Format", or ours, where the domain asks more than
 * the submission.
 */
export enum EotRule {
    EotSize = "EOTSize is the file size (EOT, §3)",
    Version = "Version is 0x00010000, 0x00020001 or 0x00020002 (EOT, §3.1–§3.3)",
    Reserved = "Reserved1..4 are 0 (EOT, §3)",
    Padding = "Padding1..6 are 0x0000 (EOT, §3)",
    EvenSize = "the size of a name and of RootString is even: each is an array of UTF-16 characters (EOT, §3)",
    BlocksInFile = "every block of the header of its version lies inside the file, the fields version 0x00020002 adds after RootString included (EOT, §3.1–§3.3)",
    FontDataLayout = "FontDataSize is not 0, and FontData follows the header directly and ends the file: the header end + FontDataSize is EOTSize (EOT, §3)",
    RootStringCheckSum = "in version 0x00020002, RootStringCheckSum is the sum of the RootString bytes XOR 0x50475342 (EOT, §4.3.2)",
    Flags = "Flags have neither TTEMBED_TTCOMPRESSED (0x00000004) nor TTEMBED_XORENCRYPTDATA (0x10000000) (ours: the codec takes out only a raw sfnt)",
    FontData = "FontData opens with an sfnt header of a version the domain accepts (EOT, §3: a TrueType or OpenType font)",
}

/**
 * A broken rule: what `BrokenEot` is built from.
 */
export type Violation = {
    rule: EotRule;
    /** Where the rule is broken: the header, a block by its name, FontData. */
    at: string;
    /** The field or the property that breaks the rule. */
    field: string;
    value: number | string;
    expected: string;
};

/**
 * A block of the variable part of the header with the names of its fields, for a message.
 */
export type NamedBlock = {
    /** `FamilyName`, `RootString`, `Signature`: the size field is this name with `Size`. */
    name: string;
    /** `Padding1` … `Padding6`: the Padding in front of the block. */
    paddingField: string;
    /** A name and RootString are UTF-16 text, Signature is bytes. */
    isText: boolean;
    block: EotBlock;
};

/**
 * RootString and the checksum version 0x00020002 keeps of it.
 */
export type RootStringCheck = {
    rootString: EotBlock;
    checkSum: number;
};

/**
 * The variable part of the header as its version lays it out.
 */
export type EotBlocks = {
    /** The four names, RootString from version 0x00020001 and Signature in version 0x00020002. */
    blocks: Array<NamedBlock>;
    /** Only in version 0x00020002. */
    rootStringCheck: RootStringCheck | undefined;
    /** The offset right after the header, possibly past the end of the file. */
    endOffset: number;
};
