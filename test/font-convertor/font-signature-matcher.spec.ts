import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";
import type { SignedExtension } from "app/font-convertor/signature-matcher/font-signature-matcher.types";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const fontSignatureMatcher = new FontSignatureMatcher();
const signedExtensions: Array<SignedExtension> = [Extension.WOFF, Extension.WOFF2, Extension.EOT];

describe("FontSignatureMatcher.matches", function () {
    const heads = new Map<Extension, Uint8Array>();

    before(async function () {
        for (const extension of Object.values(Extension)) {
            heads.set(extension, await readHead(`test-font.${extension}`));
        }
    });

    for (const extension of signedExtensions) {
        it(`accepts a real ${extension} font`, function () {
            expect(fontSignatureMatcher.matches(head(extension), extension)).to.be.true;
        });
    }

    for (const extension of Object.values(Extension)) {
        it(`rejects a real ${extension} font under a foreign extension`, function () {
            for (const other of foreignTo(extension)) {
                expect(fontSignatureMatcher.matches(head(extension), other), `${extension} passed as ${other}`).to.be.false;
            }
        });
    }

    it("keeps the offsets fixed", function () {
        // A shifted head would turn the check into a search for the marker anywhere.
        expect(fontSignatureMatcher.matches(concat("\n", "wOFF"), Extension.WOFF)).to.be.false;
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "wOF2"), Extension.WOFF2)).to.be.false;
        expect(fontSignatureMatcher.matches(concat("\n", head(Extension.EOT)), Extension.EOT)).to.be.false;
    });

    it("rejects arbitrary bytes named as a font", function () {
        // This is the case the check exists for: PostScript Type 1 under the name of a font of
        // another format. That is how fontforge answers a request to make EOT.
        const type1 = new Uint8Array([0x80, 0x01, 0x79, 0x15, 0x25, 0x21]);

        for (const extension of signedExtensions) {
            expect(fontSignatureMatcher.matches(type1, extension), `type 1 passed as ${extension}`).to.be.false;
        }
    });

    it("rejects a file shorter than the signature", function () {
        expect(fontSignatureMatcher.matches(ascii("wO"), Extension.WOFF2)).to.be.false;
        // The EOT marker lies at offset 34, which a truncated header does not reach.
        expect(fontSignatureMatcher.matches(head(Extension.EOT).subarray(0, 20), Extension.EOT)).to.be.false;
    });

    it("rejects an empty file", function () {
        for (const extension of signedExtensions) {
            expect(fontSignatureMatcher.matches(new Uint8Array(), extension), `empty passed as ${extension}`).to.be.false;
        }
    });

    function head(extension: Extension): Uint8Array {
        const bytes = heads.get(extension);

        if (!bytes) {
            throw new Error(`No fixture read for ${extension}.`);
        }

        return bytes;
    }

    function foreignTo(extension: Extension): Array<SignedExtension> {
        return signedExtensions.filter((value) => value !== extension);
    }

    function ascii(text: string): Uint8Array {
        return Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
    }

    function concat(...parts: Array<string | Array<number> | Uint8Array>): Uint8Array {
        const flat = parts.flatMap((part) => (typeof part === "string" ? Array.from(ascii(part)) : Array.from(part)));

        return Uint8Array.from(flat);
    }
});

describe("FontSignatureMatcher.headLength", function () {
    it("covers the signature of every signed format", async function () {
        for (const extension of signedExtensions) {
            const bytes = await readHead(`test-font.${extension}`);

            expect(bytes.length, `${extension} fixture is shorter than headLength`).to.equal(fontSignatureMatcher.headLength);
            expect(fontSignatureMatcher.matches(bytes, extension), `${extension} needs more than headLength bytes`).to.be.true;
        }
    });
});

async function readHead(name: string): Promise<Uint8Array> {
    const content = await fs.readFile(path.join(fixtureDir, name));

    return Uint8Array.from(content).subarray(0, fontSignatureMatcher.headLength);
}
