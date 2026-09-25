/**
 * What the domain skips before matching the bytes of a signature.
 */
export enum Prefix {
    /** The UTF-8 BOM, if present. */
    Bom = "bom",
    /** The UTF-8 BOM and leading whitespace. */
    Indent = "indent",
}

/**
 * A byte class: the signature checks which set a byte belongs to, not its value.
 */
export enum ByteClass {
    /**
     * The first byte after `<` a markup document may open with: a letter (the root tag) or `!`
     * (a DOCTYPE, a comment).
     */
    MarkupStart = "markup-start",
    /** A text byte: a byte outside the C0 controls, or markup whitespace. */
    Text = "text",
}

/**
 * A signature byte: a constant value or a byte class.
 */
export type SignatureByte = number | ByteClass;

/**
 * A format signature: the bytes the domain expects at an offset from the end of the prefix.
 */
export type Signature = {
    offset: number;
    bytes: Array<SignatureByte>;
    /** Without the field the signature lies at a fixed offset from the start of the file. */
    prefix?: Prefix;
};
