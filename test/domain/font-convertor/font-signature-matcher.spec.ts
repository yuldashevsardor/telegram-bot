import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const fontSignatureMatcher = new FontSignatureMatcher();

describe("FontSignatureMatcher.matches", function () {
    const heads = new Map<Extension, Uint8Array>();

    before(async function () {
        for (const extension of Object.values(Extension)) {
            heads.set(extension, await readHead(`fixture.${extension}`));
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

    it("accepts the legacy Macintosh and the collection flavours of ttf", function () {
        expect(fontSignatureMatcher.matches(ascii("true"), Extension.TTF)).to.be.true;
        expect(fontSignatureMatcher.matches(ascii("ttcf"), Extension.TTF)).to.be.true;
    });

    it("accepts either outline flavour under both sfnt extensions", function () {
        // Расширение не диктует тип обводок: .otf с обводками TrueType и .ttf с CFF
        // допускаются спецификацией, и движок открывает оба.
        expect(fontSignatureMatcher.matches(head(Extension.TTF), Extension.OTF)).to.be.true;
        expect(fontSignatureMatcher.matches(head(Extension.OTF), Extension.TTF)).to.be.true;
    });

    it("accepts an svg starting with the root tag instead of the xml declaration", function () {
        expect(fontSignatureMatcher.matches(ascii("<svg xmlns="), Extension.SVG)).to.be.true;
    });

    it("rejects arbitrary bytes named as a font", function () {
        // Ровно тот случай, ради которого проверка и заведена: PostScript Type 1 под
        // именем шрифта другого формата — так выглядят фикстуры в tmp/app/test-fonts.
        const type1 = new Uint8Array([0x80, 0x01, 0x79, 0x15, 0x25, 0x21]);

        for (const extension of Object.values(Extension)) {
            expect(fontSignatureMatcher.matches(type1, extension), `type 1 passed as ${extension}`).to.be.false;
        }
    });

    it("rejects a file shorter than the signature", function () {
        expect(fontSignatureMatcher.matches(new Uint8Array([0x00, 0x01]), Extension.TTF)).to.be.false;
        // У EOT маркер лежит по смещению 34, до него обрезанный заголовок не достаёт.
        expect(fontSignatureMatcher.matches(head(Extension.EOT).subarray(0, 20), Extension.EOT)).to.be.false;
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

    // TTF и OTF по содержимому неразличимы: контейнер sfnt у них общий.
    function foreignTo(extension: Extension): Array<Extension> {
        const sfnt = [Extension.TTF, Extension.OTF];
        const same = sfnt.includes(extension) ? sfnt : [extension];

        return Object.values(Extension).filter((value) => !same.includes(value));
    }

    function ascii(text: string): Uint8Array {
        return Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
    }
});

describe("FontSignatureMatcher.headLength", function () {
    it("covers the signature of every format", async function () {
        for (const extension of Object.values(Extension)) {
            const bytes = await readHead(`fixture.${extension}`);

            expect(bytes.length, `${extension} fixture is shorter than headLength`).to.equal(fontSignatureMatcher.headLength);
            expect(fontSignatureMatcher.matches(bytes, extension), `${extension} needs more than headLength bytes`).to.be.true;
        }
    });
});

async function readHead(name: string): Promise<Uint8Array> {
    const content = await fs.readFile(path.join(fixtureDir, name));

    return Uint8Array.from(content).subarray(0, fontSignatureMatcher.headLength);
}
