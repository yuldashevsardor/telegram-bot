import { injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { Signature, SignedExtension } from "app/font-convertor/signature-matcher/font-signature-matcher.types";
import { SFNT_VERSIONS, sfntVersionBytes } from "app/font-convertor/sfnt-version";

@injectable()
export class FontSignatureMatcher {
    // EOT has no signature at the start of the file: the header opens with the file and font
    // data sizes. The format marker (USHORT 0x504C, little-endian) lies at a fixed offset.
    private static readonly EOT_MAGIC_OFFSET = 34;

    private readonly signaturesByExtension: Record<SignedExtension, Array<Signature>>;

    /**
     * How many bytes from the start of the file have to be read to check any signed format.
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
            [Extension.WOFF2]: [{ offset: 0, bytes: this.ascii("wOF2") }],
            [Extension.EOT]: [{ offset: FontSignatureMatcher.EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
        };

        this.headLength = this.calculateHeadLength();
    }

    /**
     * Whether the start of the file matches the format signature.
     */
    public matches(head: Uint8Array, extension: SignedExtension): boolean {
        // A file shorter than the signature gives `undefined` past its end, which equals no byte.
        return this.signaturesByExtension[extension].some((signature) =>
            signature.bytes.every((byte, index) => head[signature.offset + index] === byte),
        );
    }

    private calculateHeadLength(): number {
        const signatures = Object.values(this.signaturesByExtension).flat();

        return signatures.reduce((length, signature) => Math.max(length, signature.offset + signature.bytes.length), 0);
    }

    private ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
