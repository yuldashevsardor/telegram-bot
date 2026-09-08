import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FontSignature } from "app/domain/font-convertor/font-signature";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");

describe("FontSignature.matches", function () {
    const heads = new Map<Extension, Uint8Array>();

    before(async function () {
        for (const extension of Object.values(Extension)) {
            heads.set(extension, await readHead(`fixture.${extension}`));
        }
    });

    for (const extension of Object.values(Extension)) {
        it(`accepts a real ${extension} font`, function () {
            expect(FontSignature.matches(head(extension), extension)).to.be.true;
        });

        it(`rejects a real ${extension} font under any other extension`, function () {
            for (const other of Object.values(Extension).filter((value) => value !== extension)) {
                expect(FontSignature.matches(head(extension), other), `${extension} passed as ${other}`).to.be.false;
            }
        });
    }

    it("accepts the legacy Macintosh and the collection flavours of ttf", function () {
        expect(FontSignature.matches(ascii("true"), Extension.TTF)).to.be.true;
        expect(FontSignature.matches(ascii("ttcf"), Extension.TTF)).to.be.true;
    });

    it("accepts an svg starting with the root tag instead of the xml declaration", function () {
        expect(FontSignature.matches(ascii("<svg xmlns="), Extension.SVG)).to.be.true;
    });

    it("rejects arbitrary bytes named as a font", function () {
        // Ровно тот случай, ради которого проверка и заведена: PostScript Type 1 под
        // именем шрифта другого формата — так выглядят фикстуры в tmp/app/test-fonts.
        const type1 = new Uint8Array([0x80, 0x01, 0x79, 0x15, 0x25, 0x21]);

        for (const extension of Object.values(Extension)) {
            expect(FontSignature.matches(type1, extension), `type 1 passed as ${extension}`).to.be.false;
        }
    });

    it("rejects a file shorter than the signature", function () {
        expect(FontSignature.matches(new Uint8Array([0x00, 0x01]), Extension.TTF)).to.be.false;
        // У EOT маркер лежит по смещению 34, до него обрезанный заголовок не достаёт.
        expect(FontSignature.matches(head(Extension.EOT).subarray(0, 20), Extension.EOT)).to.be.false;
    });

    it("rejects an empty file", function () {
        for (const extension of Object.values(Extension)) {
            expect(FontSignature.matches(new Uint8Array(), extension), `empty passed as ${extension}`).to.be.false;
        }
    });

    function head(extension: Extension): Uint8Array {
        const bytes = heads.get(extension);

        if (!bytes) {
            throw new Error(`No fixture read for ${extension}.`);
        }

        return bytes;
    }

    function ascii(text: string): Uint8Array {
        return Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
    }
});

describe("FontSignature.headLength", function () {
    it("covers the signature of every format", async function () {
        for (const extension of Object.values(Extension)) {
            const bytes = await readHead(`fixture.${extension}`);

            expect(bytes.length, `${extension} fixture is shorter than headLength`).to.equal(FontSignature.headLength);
            expect(FontSignature.matches(bytes, extension), `${extension} needs more than headLength bytes`).to.be.true;
        }
    });
});

async function readHead(name: string): Promise<Uint8Array> {
    const content = await fs.readFile(path.join(fixtureDir, name));

    return Uint8Array.from(content).subarray(0, FontSignature.headLength);
}
