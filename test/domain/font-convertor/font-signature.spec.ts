import { expect } from "chai";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { FONT_SIGNATURE_HEAD_LENGTH, FontSignature } from "app/domain/font-convertor/font-signature";

describe("FontSignature.matches", function () {
    const headsByExtension: Record<string, Uint8Array> = {
        [Extension.TTF]: head([0x00, 0x01, 0x00, 0x00]),
        [Extension.OTF]: head(ascii("OTTO")),
        [Extension.WOFF]: head(ascii("wOFF")),
        [Extension.WOFF2]: head(ascii("wOF2")),
        [Extension.EOT]: eotHead(),
    };

    for (const [extension, fontHead] of Object.entries(headsByExtension)) {
        it(`принимает заголовок ${extension}`, function () {
            expect(FontSignature.matches(fontHead, extension as Extension)).to.be.true;
        });

        it(`отвергает заголовок ${extension} под чужим расширением`, function () {
            const others = Object.keys(headsByExtension).filter((other) => other !== extension);

            for (const other of others) {
                expect(FontSignature.matches(fontHead, other as Extension), `${extension} принят как ${other}`).to.be.false;
            }
        });
    }

    it("принимает старую макинтошевскую сигнатуру TTF и коллекцию", function () {
        expect(FontSignature.matches(head(ascii("true")), Extension.TTF)).to.be.true;
        expect(FontSignature.matches(head(ascii("ttcf")), Extension.TTF)).to.be.true;
    });

    it("отвергает произвольные байты под именем шрифта", function () {
        // Ровно тот случай, ради которого проверка и заведена: PostScript Type 1,
        // переименованный в .woff2 (такие файлы лежат в tmp/app/test-fonts).
        const pfb = head([0x80, 0x01, 0x79, 0x15]);

        for (const extension of Object.values(Extension)) {
            if (extension === Extension.SVG) {
                continue;
            }

            expect(FontSignature.matches(pfb, extension), `PFB принят как ${extension}`).to.be.false;
        }
    });

    it("отвергает файл короче сигнатуры", function () {
        expect(FontSignature.matches(new Uint8Array([0x00, 0x01]), Extension.TTF)).to.be.false;
        // У EOT маркер лежит по смещению 34: обрезанный заголовок до него не достаёт.
        expect(FontSignature.matches(eotHead().subarray(0, 20), Extension.EOT)).to.be.false;
    });

    it("пропускает формат без известной сигнатуры", function () {
        expect(FontSignature.matches(head(ascii("<?xml version")), Extension.SVG)).to.be.true;
    });

    function ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }

    function head(signature: Array<number>): Uint8Array {
        const bytes = new Uint8Array(FONT_SIGNATURE_HEAD_LENGTH);
        bytes.set(signature);

        return bytes;
    }

    function eotHead(): Uint8Array {
        const bytes = new Uint8Array(FONT_SIGNATURE_HEAD_LENGTH);
        const view = new DataView(bytes.buffer);

        view.setUint32(0, FONT_SIGNATURE_HEAD_LENGTH, true);
        view.setUint32(4, 0, true);
        view.setUint32(8, 0x00020002, true);
        view.setUint16(34, 0x504c, true);

        return bytes;
    }
});
