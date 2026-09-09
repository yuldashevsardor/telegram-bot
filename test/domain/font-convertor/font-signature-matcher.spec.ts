import { expect } from "chai";
import fs from "fs/promises";
import path from "path";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FontSignatureMatcher } from "app/domain/font-convertor/font-signature-matcher";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "fonts");
const fontSignatureMatcher = new FontSignatureMatcher();
// Начало настоящего документа: обрубок вроде `<svg` короче сигнатуры SVG.
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
        // Контейнер у коллекции тот же, но шрифтов в ней несколько, и выбирать из них
        // домен не берётся: под sfnt-именем она не проходит.
        expect(fontSignatureMatcher.matches(ascii("ttcf"), Extension.TTF)).to.be.false;
        expect(fontSignatureMatcher.matches(ascii("ttcf"), Extension.OTF)).to.be.false;
    });

    it("accepts either outline flavour under both sfnt extensions", function () {
        // Расширение не диктует тип обводок: .otf с обводками TrueType и .ttf с CFF
        // допускаются спецификацией, и движок открывает оба.
        expect(fontSignatureMatcher.matches(head(Extension.TTF), Extension.OTF)).to.be.true;
        expect(fontSignatureMatcher.matches(head(Extension.OTF), Extension.TTF)).to.be.true;
    });

    it("accepts an svg starting with the root tag instead of the xml declaration", function () {
        expect(fontSignatureMatcher.matches(ascii(rootTag), Extension.SVG)).to.be.true;
    });

    it("accepts an svg whose document opens with a doctype or a comment", function () {
        // Объявление XML необязательно, а доктайп и комментарий перед корневым тегом
        // законны и встречаются в выводе редакторов; движок такие файлы открывает.
        expect(fontSignatureMatcher.matches(ascii('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"'), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(ascii("<!-- made by an editor -->"), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat("  ", "<!DOCTYPE svg"), Extension.SVG)).to.be.true;
    });

    it("accepts an svg opening with a processing instruction whose target starts with xml", function () {
        // Классом начала разметки инструкция обработки не покрыта: её пропускает
        // сигнатура `<?xml`, поэтому проходит только таргет с таким началом.
        expect(fontSignatureMatcher.matches(ascii('<?xml-stylesheet href="a.css"?>'), Extension.SVG)).to.be.true;
    });

    it("accepts an svg saved with a UTF-8 BOM", function () {
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "<?xml version="), Extension.SVG)).to.be.true;
    });

    it("accepts an svg with a blank line before the root tag", function () {
        expect(fontSignatureMatcher.matches(concat("\r\n  ", rootTag), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "\n", rootTag), Extension.SVG)).to.be.true;
    });

    it("rejects an svg indented before the xml declaration", function () {
        // Объявление XML обязано открывать документ, и движок такой файл не открывает:
        // перед `<?xml` домен пропускает только BOM.
        expect(fontSignatureMatcher.matches(concat("\n  ", "<?xml version="), Extension.SVG)).to.be.false;
    });

    it("rejects text that opens with an angle bracket but not with markup", function () {
        // Сигнатура ослаблена до «это разметка», но не до «первый байт — `<`»: за
        // скобкой обязано идти начало тега, доктайпа или комментария. Входы длиннее
        // сигнатуры, а хвост у них текстовый: отказ даёт второй байт, а не проверка
        // длины в `matches` и не класс текста.
        expect(fontSignatureMatcher.matches(ascii("</svg> and more text"), Extension.SVG)).to.be.false;
        expect(fontSignatureMatcher.matches(concat("<", [0x00], "0123456789"), Extension.SVG)).to.be.false;
    });

    it("rejects a binary head that opens like markup", function () {
        // Ровно тот случай, из-за которого сигнатура требует хвост: размер файла в
        // заголовке фикстуры EOT даёт `<m`, а дальше идут управляющие байты.
        expect(fontSignatureMatcher.matches(head(Extension.EOT), Extension.SVG)).to.be.false;
        // Та же пара, но байты свои: случай не зависит от того, чем открывается фикстура.
        expect(fontSignatureMatcher.matches(concat("<m", new Uint8Array(10)), Extension.SVG)).to.be.false;
    });

    it("rejects an svg whose root tag starts beyond the prefix limit", function () {
        // Предел пропуска конечен: иначе голова файла должна была бы расти вместе с
        // отступом. Отступ в 17 пробелов за него уже выходит.
        expect(fontSignatureMatcher.matches(concat(" ".repeat(17), rootTag), Extension.SVG)).to.be.false;
    });

    it("measures the indent of an svg past the BOM, not together with it", function () {
        // Иначе невидимый BOM укорачивал бы допустимый отступ, и один и тот же
        // документ из разных редакторов проходил бы проверку по-разному.
        const bom = [0xef, 0xbb, 0xbf];

        expect(fontSignatureMatcher.matches(concat(bom, " ".repeat(16), rootTag), Extension.SVG)).to.be.true;
        expect(fontSignatureMatcher.matches(concat(bom, " ".repeat(17), rootTag), Extension.SVG)).to.be.false;
    });

    it("keeps the offsets of binary formats fixed", function () {
        // Пропуск префикса заведён для текстового формата: у двоичных сдвиг головы
        // превратил бы проверку в поиск маркера где попало.
        expect(fontSignatureMatcher.matches(concat("\n", "wOFF"), Extension.WOFF)).to.be.false;
        expect(fontSignatureMatcher.matches(concat([0xef, 0xbb, 0xbf], "OTTO"), Extension.OTF)).to.be.false;
        expect(fontSignatureMatcher.matches(concat("\n", head(Extension.EOT)), Extension.EOT)).to.be.false;
    });

    it("rejects arbitrary bytes named as a font", function () {
        // Ровно тот случай, ради которого проверка и заведена: PostScript Type 1 под
        // именем шрифта другого формата — так fontforge отвечает на просьбу сделать EOT.
        const type1 = new Uint8Array([0x80, 0x01, 0x79, 0x15, 0x25, 0x21]);

        for (const extension of Object.values(Extension)) {
            expect(fontSignatureMatcher.matches(type1, extension), `type 1 passed as ${extension}`).to.be.false;
        }
    });

    it("rejects a file shorter than the signature", function () {
        expect(fontSignatureMatcher.matches(new Uint8Array([0x00, 0x01]), Extension.TTF)).to.be.false;
        // У EOT маркер лежит по смещению 34, до него обрезанный заголовок не достаёт.
        expect(fontSignatureMatcher.matches(head(Extension.EOT).subarray(0, 20), Extension.EOT)).to.be.false;
        // Одной скобки не хватает ни на объявление XML, ни на начало разметки с хвостом.
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

    // TTF и OTF по содержимому неразличимы: контейнер sfnt у них общий.
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
