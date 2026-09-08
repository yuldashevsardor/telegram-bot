import { Extension } from "app/domain/font-convertor/font-convertor.types";

type Signature = {
    offset: number;
    bytes: Array<number>;
};

export class FontSignature {
    // У EOT нет сигнатуры в начале файла: заголовок открывается размерами шрифта, а
    // маркер формата (USHORT 0x504C, little-endian) лежит по фиксированному смещению.
    private static readonly EOT_MAGIC_OFFSET = 34;

    // TTF и OTF делят один контейнер sfnt, отдельного маркера формата в нём нет:
    // различает их версия sfnt, то есть тип обводов — 0x00010000 у TrueType (плюс
    // "true" старых макинтошевских шрифтов и "ttcf" коллекций) против "OTTO" у CFF.
    private static readonly signaturesByExtension: Record<Extension, Array<Signature>> = {
        [Extension.TTF]: [
            { offset: 0, bytes: [0x00, 0x01, 0x00, 0x00] },
            { offset: 0, bytes: FontSignature.ascii("true") },
            { offset: 0, bytes: FontSignature.ascii("ttcf") },
        ],
        [Extension.OTF]: [{ offset: 0, bytes: FontSignature.ascii("OTTO") }],
        [Extension.WOFF]: [{ offset: 0, bytes: FontSignature.ascii("wOFF") }],
        [Extension.WOFF2]: [{ offset: 0, bytes: FontSignature.ascii("wOF2") }],
        [Extension.EOT]: [{ offset: FontSignature.EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
        // SVG — единственный текстовый формат здесь, и его сигнатура слабее прочих: она
        // говорит «это XML», а не «это шрифт». Разбирать разметку домен не станет, но и
        // такой проверки хватает, чтобы бинарный мусор под именем *.svg не прошёл.
        [Extension.SVG]: [
            { offset: 0, bytes: FontSignature.ascii("<?xml") },
            { offset: 0, bytes: FontSignature.ascii("<svg") },
        ],
    };

    /**
     * Сколько байт от начала файла нужно прочитать, чтобы проверить любой формат.
     */
    public static readonly headLength: number = Object.values(FontSignature.signaturesByExtension)
        .flat()
        .reduce((length, signature) => Math.max(length, signature.offset + signature.bytes.length), 0);

    /**
     * Совпадает ли начало файла с сигнатурой формата.
     */
    public static matches(head: Uint8Array, extension: Extension): boolean {
        return FontSignature.signaturesByExtension[extension].some((signature) => {
            if (signature.offset + signature.bytes.length > head.length) {
                return false;
            }

            return signature.bytes.every((byte, index) => head[signature.offset + index] === byte);
        });
    }

    private static ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
