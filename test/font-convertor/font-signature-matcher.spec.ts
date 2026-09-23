import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/font-convertor/signature-matcher/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const fontSignatureMatcher = new FontSignatureMatcher();
// The start of a real document: a stub like `<svg` is shorter than the SVG signature.
const rootTag = '<svg xmlns="http://www.w3.org/2000/svg"';

describe("FontSignatureMatcher.matches", function () {
    const heads = new Map<Extension, Uint8Array>();

    before(async function () {
        for (const extension of Object.values(Extension)) {
            heads.set(extension, await readHead(`test-font.${extension}`));
        }
    });

    for (const extension of Object.values(Extension)) {
        it(`accepts a real ${extension} font`, function () {
            expect(fontSignatureMatcher.matches(head(extension), extension)).to.be.true;
        });

        it(`rejects a real ${extension} font under a foreign extension`, function () {
            for (const other of foreignTo(extension)) {
                expect(fontSignatureMatcher.matches(head(extension), other), `${extension} passed as ${other}`).to.be.false;
            }
        });
    }

    it("accepts the legacy Macintosh flavour of ttf", function () {
        expect(fontSignatureMatcher.matches(ascii("true"), Extension.TTF)).to.be.true;
    });

    it("rejects a font collection under both sfnt extensions", function () {
        // A collection has the same container but several fonts, and the domain does not pick
        // one of them: under an sfnt name it does not pass.
        expect(fontSignatureMatcher.matches(ascii("ttcf"), Extension.TTF)).to.be.false;
        expect(fontSignatureMatcher.matches(ascii("ttcf"), Extension.OTF)).to.be.false;
    });

    it("accepts either outline flavour under both sfnt extensions", function () {
        // The extension does not dictate the outline type: the specification allows .otf with
        // TrueType outlines and .ttf with CFF, and the engine opens both.
        expect(fontSignatureMatcher.matches(head(Extension.TTF), Extension.OTF)).to.be.true;
        expect(fontSignatureMatcher.matches(head(Extension.OTF), Extension.TTF)).to.be.true;
    });

    it("accepts an svg starting with the root tag instead of the xml declaration", function () {
        expect(fontSignatureMatcher.matches(ascii(rootTag), Extension.SVG)).to.be.true;
    });

    it("accepts an svg whose document opens with a doctype or a comment", function () {
        // The XML declaration is optional, and a doctype or a comment before the root tag is
        // legal and shows up in editor output; the engine opens such files.
        expect(fontSignatureMatcher.matches(ascii('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"'), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(ascii("<!-- made by an editor -->"), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat("  ", "<!DOCTYPE svg"), Extension.SVG)).to.be.true;
    });

    it("accepts an svg opening with a processing instruction whose target starts with xml", function () {
        // The markup-start class does not cover a processing instruction: the `<?xml`
        // signature lets it through, so only a target with that beginning passes.
        expect(fontSignatureMatcher.matches(ascii('<?xml-stylesheet href="a.css"?>'), Extension.SVG)).to.be.true;
    });

    it("accepts an svg saved with a UTF-8 BOM", function () {
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "<?xml version="), Extension.SVG)).to.be.true;
    });

    it("rejects an svg behind a damaged BOM", function () {
        // The BOM is recognised by all three bytes: otherwise bytes that merely begin it would be
        // skipped before the XML declaration as a prologue.
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0x3f], "<?xml version="), Extension.SVG)).to.be.false;
    });

    it("accepts an svg with a blank line before the root tag", function () {
        expect(fontSignatureMatcher.matches(concat("\r\n  ", rootTag), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "\n", rootTag), Extension.SVG)).to.be.true;
    });

    it("rejects an svg indented before the xml declaration", function () {
        // The XML declaration has to open the document, and the engine does not open such a
        // file: before `<?xml` the domain skips only the BOM.
        expect(fontSignatureMatcher.matches(concat("\n  ", "<?xml version="), Extension.SVG)).to.be.false;
    });

    it("accepts markup opening with a letter of either case", function () {
        // The SVG root tag is lowercase, but a tag with a namespace prefix is markup too, and a
        // prefix can be of either case. The letters are taken from the edges of both ranges.
        for (const letter of ["A", "Z", "a", "z"]) {
            const markup = ascii(`<${letter}:svg xmlns:${letter}="http://www.w3.org/2000/svg"`);

            expect(fontSignatureMatcher.matches(markup, Extension.SVG), letter).to.be.true;
        }
    });

    it("rejects text that opens with an angle bracket but not with markup", function () {
        // The signature is relaxed to "this is markup", not to "the first byte is `<`": the
        // bracket has to be followed by the start of a tag, a doctype or a comment. The inputs
        // are longer than the signature and their tail is text: the rejection comes from the
        // second byte, not from missing bytes or from the text class.
        expect(fontSignatureMatcher.matches(ascii("</svg> and more text"), Extension.SVG)).to.be.false;
        expect(fontSignatureMatcher.matches(concat("<", [0x00], "0123456789"), Extension.SVG)).to.be.false;

        // The neighbours of the letter ranges: none of them opens a tag name.
        for (const char of ["@", "[", "`", "{"]) {
            expect(fontSignatureMatcher.matches(ascii(`<${char}svg xmlns="http://www.w3.org/2000/svg"`), Extension.SVG), char).to.be.false;
        }
    });

    it("rejects a binary head that opens like markup", function () {
        // Exactly the case the signature requires a tail for: the file size in the header of
        // the EOT fixture gives `<m`, followed by control bytes.
        expect(fontSignatureMatcher.matches(head(Extension.EOT), Extension.SVG)).to.be.false;
        // The same pair with bytes of our own: the case does not depend on how the fixture opens.
        expect(fontSignatureMatcher.matches(concat("<m", new Uint8Array(10)), Extension.SVG)).to.be.false;
    });

    it("rejects an svg whose root tag starts beyond the prefix limit", function () {
        // The skip has a limit: otherwise the head of the file would have to grow with the
        // indent. An indent of 17 spaces is already past it.
        expect(fontSignatureMatcher.matches(concat(" ".repeat(17), rootTag), Extension.SVG)).to.be.false;
    });

    it("measures the indent of an svg past the BOM, not together with it", function () {
        // Otherwise an invisible BOM would shorten the allowed indent, and the same document
        // from different editors would pass the check differently.
        const bom = [0xef, 0xbb, 0xbf];

        expect(fontSignatureMatcher.matches(concat(bom, " ".repeat(16), rootTag), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat(bom, " ".repeat(17), rootTag), Extension.SVG)).to.be.false;
    });

    it("keeps the offsets of binary formats fixed", function () {
        // Skipping a prefix exists for the text format: for binary formats a shifted head would
        // turn the check into a search for the marker anywhere.
        expect(fontSignatureMatcher.matches(concat("\n", "wOFF"), Extension.WOFF)).to.be.false;
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "OTTO"), Extension.OTF)).to.be.false;
        expect(fontSignatureMatcher.matches(concat("\n", head(Extension.EOT)), Extension.EOT)).to.be.false;
    });

    it("rejects arbitrary bytes named as a font", function () {
        // Exactly the case the check exists for: PostScript Type 1 under the name of a font of
        // another format — that is how fontforge answers a request to make EOT.
        const type1 = new Uint8Array([0x80, 0x01, 0x79, 0x15, 0x25, 0x21]);

        for (const extension of Object.values(Extension)) {
            expect(fontSignatureMatcher.matches(type1, extension), `type 1 passed as ${extension}`).to.be.false;
        }
    });

    it("rejects a file shorter than the signature", function () {
        expect(fontSignatureMatcher.matches(new Uint8Array([0x00, 0x01]), Extension.TTF)).to.be.false;
        // The EOT marker lies at offset 34, which a truncated header does not reach.
        expect(fontSignatureMatcher.matches(head(Extension.EOT).subarray(0, 20), Extension.EOT)).to.be.false;
        // A single bracket is enough for neither the XML declaration nor a markup start with a tail.
        expect(fontSignatureMatcher.matches(ascii("<"), Extension.SVG)).to.be.false;
    });

    it("rejects an empty file", function () {
        for (const extension of Object.values(Extension)) {
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

    // TTF and OTF are indistinguishable by content: they share the sfnt container.
    function foreignTo(extension: Extension): Array<Extension> {
        const sfnt = [Extension.TTF, Extension.OTF];
        const same = sfnt.includes(extension) ? sfnt : [extension];

        return Object.values(Extension).filter((value) => !same.includes(value));
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
    it("covers the signature of every format", async function () {
        for (const extension of Object.values(Extension)) {
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
