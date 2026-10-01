import { injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import type { Signature, SignedExtension } from "app/font-convertor/signature-matcher/font-signature-matcher.types";

@injectable()
export class FontSignatureMatcher {
    private readonly signaturesByExtension: Record<SignedExtension, Array<Signature>>;

    /**
     * How many bytes from the start of the file have to be read to check any signed format.
     */
    public readonly headLength: number;

    public constructor() {
        this.signaturesByExtension = {
            [Extension.WOFF2]: [{ offset: 0, bytes: this.ascii("wOF2") }],
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
