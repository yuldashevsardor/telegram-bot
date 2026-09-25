import { injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { Signature, SignatureByte } from "app/font-convertor/signature-matcher/font-signature-matcher.types";
import { ByteClass, Prefix } from "app/font-convertor/signature-matcher/font-signature-matcher.types";
import { SFNT_VERSIONS, sfntVersionBytes } from "app/font-convertor/sfnt-version";

@injectable()
export class FontSignatureMatcher {
    // EOT has no signature at the start of the file: the header opens with the file and font
    // data sizes. The format marker (USHORT 0x504C, little-endian) lies at a fixed offset.
    private static readonly EOT_MAGIC_OFFSET = 34;

    private static readonly UTF8_BOM = [0xef, 0xbb, 0xbf];
    // XML whitespace: space, tab, line feed, carriage return.
    private static readonly XML_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d];
    // The indent limit, not counting the BOM. Without a limit the file head would grow with the indent.
    private static readonly MAX_INDENT_LENGTH = 16;

    // What a markup document may open with after `<`: a letter of the root tag or the `!` of a
    // DOCTYPE or a comment.
    private static readonly EXCLAMATION_MARK = 0x21;
    private static readonly LETTER_RANGES: Array<[number, number]> = [
        [0x41, 0x5a],
        [0x61, 0x7a],
    ];
    // The boundary of the C0 control bytes. Below it lie only controls, which text does not have;
    // markup whitespace is checked separately. Above it DEL and the C1 controls pass too, although
    // they are not text. They cannot be separated out: the high bytes are needed whole, UTF-8
    // lives in them.
    private static readonly FIRST_NON_C0_BYTE = 0x20;
    // How many text bytes the signature requires after the markup start. A `<` with a letter is
    // not enough, because a binary head forms such a pair by chance: the EOT header opens with the
    // file size, and in the fixture its low bytes give `<m`. After the pair a binary format has
    // control bytes, a document has text.
    private static readonly MARKUP_TAIL_LENGTH = 10;

    private readonly signaturesByExtension: Record<Extension, Array<Signature>>;

    /**
     * How many bytes from the start of the file have to be read to check any format.
     */
    public readonly headLength: number;

    public constructor() {
        // TTF and OTF share the sfnt container and cannot be told apart by content, so the
        // signature confirms the container, and the extension picks the conversion pair
        // (docs/architecture/font-convertor.md, "Signatures").
        //
        // The version set is shared with the codec. Which versions the domain accepts, and why the
        // collection ("ttcf") is not among them, is said at `SFNT_VERSIONS`.
        const sfnt: Array<Signature> = SFNT_VERSIONS.map((version) => ({ offset: 0, bytes: sfntVersionBytes(version) }));

        this.signaturesByExtension = {
            [Extension.TTF]: sfnt,
            [Extension.OTF]: sfnt,
            [Extension.WOFF]: [{ offset: 0, bytes: this.ascii("wOFF") }],
            [Extension.WOFF2]: [{ offset: 0, bytes: this.ascii("wOF2") }],
            [Extension.EOT]: [{ offset: FontSignatureMatcher.EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
            // SVG is the only text format here, and its signature is the weakest: it says "this is
            // markup", not "this is a font". The domain does not parse the document, but this check
            // is enough to keep binary junk named *.svg out.
            //
            // The second signature looks for any markup start, not for the root tag. A DOCTYPE or
            // a comment may come first, and enumerating prologues would mean extending the
            // signature for each new one.
            //
            // `<?xml` has a signature of its own because its prefix differs: whitespace is legal
            // before any other markup, but only a BOM before `<?xml`. The XML declaration has to
            // open the document, and fontforge does not open a file indented before it. For the
            // same reason `?` is not in the markup-start class: otherwise an indent would become
            // allowed before the declaration too. So a processing instruction passes only if it
            // starts with `<?xml` and has no indent.
            [Extension.SVG]: [
                { offset: 0, bytes: this.ascii("<?xml"), prefix: Prefix.Bom },
                { offset: 0, bytes: [...this.ascii("<"), ByteClass.MarkupStart, ...this.markupTail()], prefix: Prefix.Indent },
            ],
        };

        this.headLength = this.calculateHeadLength();
    }

    /**
     * Whether the start of the file matches the format signature.
     */
    public matches(head: Uint8Array, extension: Extension): boolean {
        return this.signaturesByExtension[extension].some((signature) => {
            const start = this.prefixLength(head, signature.prefix) + signature.offset;

            return signature.bytes.every((byte, index) => this.matchesByte(head[start + index], byte));
        });
    }

    private matchesByte(byte: number | undefined, expected: SignatureByte): boolean {
        // No byte — the file is shorter than the signature. This branch is the length check: a
        // separate check in `matches` would make it unreachable.
        if (byte === undefined) {
            return false;
        }

        if (typeof expected === "number") {
            return byte === expected;
        }

        switch (expected) {
            case ByteClass.MarkupStart:
                return this.isMarkupStart(byte);
            case ByteClass.Text:
                return this.isText(byte);
        }
    }

    private isMarkupStart(byte: number): boolean {
        const isLetter = FontSignatureMatcher.LETTER_RANGES.some(([from, to]) => byte >= from && byte <= to);

        return isLetter || byte === FontSignatureMatcher.EXCLAMATION_MARK;
    }

    private isText(byte: number): boolean {
        // Stryker disable next-line EqualityOperator: `>` is equivalent: the threshold itself is the space, which isXmlWhitespace lets through as well
        return byte >= FontSignatureMatcher.FIRST_NON_C0_BYTE || this.isXmlWhitespace(byte);
    }

    private markupTail(): Array<SignatureByte> {
        return Array.from({ length: FontSignatureMatcher.MARKUP_TAIL_LENGTH }, () => ByteClass.Text);
    }

    private prefixLength(head: Uint8Array, prefix?: Prefix): number {
        if (prefix === undefined) {
            return 0;
        }

        const bomLength = FontSignatureMatcher.UTF8_BOM.every((byte, index) => head[index] === byte)
            ? FontSignatureMatcher.UTF8_BOM.length
            : 0;

        switch (prefix) {
            case Prefix.Bom:
                return bomLength;
            case Prefix.Indent:
                // The indent is counted past the BOM, not together with it. With a shared budget an
                // invisible BOM would shorten the allowed indent, and the same document saved by
                // different editors would pass the check differently.
                return bomLength + this.indentLength(head, bomLength);
        }
    }

    private indentLength(head: Uint8Array, offset: number): number {
        let length = 0;

        while (length < FontSignatureMatcher.MAX_INDENT_LENGTH && this.isXmlWhitespace(head[offset + length])) {
            length += 1;
        }

        return length;
    }

    private isXmlWhitespace(byte: number | undefined): boolean {
        return byte !== undefined && FontSignatureMatcher.XML_WHITESPACE.includes(byte);
    }

    private calculateHeadLength(): number {
        const signatures = Object.values(this.signaturesByExtension).flat();

        // A skipped prefix shortens the useful part of the head, so the maximum length of its
        // prefix is added to the signature.
        return signatures.reduce(
            (length, signature) => Math.max(length, this.maxPrefixLength(signature.prefix) + signature.offset + signature.bytes.length),
            0,
        );
    }

    private maxPrefixLength(prefix?: Prefix): number {
        // The marks below rest on one fact: EOT sets headLength today, not SVG. The EOT marker lies
        // further than the SVG signature ends even with the maximum prefix, so a wrong prefix length
        // does not change the result. Once the SVG signature outgrows EOT, drop the marks.
        // Stryker disable next-line ConditionalExpression: `true` is equivalent while EOT sets headLength
        if (prefix === undefined) {
            return 0;
        }

        switch (prefix) {
            // Stryker disable next-line ConditionalExpression: falling through to `Prefix.Indent` is equivalent while EOT sets headLength
            case Prefix.Bom:
                return FontSignatureMatcher.UTF8_BOM.length;
            case Prefix.Indent:
                // Stryker disable next-line ArithmeticOperator: `-` is equivalent while EOT sets headLength
                return FontSignatureMatcher.UTF8_BOM.length + FontSignatureMatcher.MAX_INDENT_LENGTH;
        }
    }

    private ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
