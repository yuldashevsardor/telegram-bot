import { Extension } from "app/domain/font-convertor/font-convertor.types";

type Signature = {
    offset: number;
    bytes: Array<number>;
};

function asciiBytes(text: string): Array<number> {
    return Array.from(text, (char) => char.charCodeAt(0));
}

// У EOT нет сигнатуры в начале файла: заголовок открывается размерами шрифта, а маркер
// формата (USHORT 0x504C, little-endian) лежит по фиксированному смещению.
const EOT_MAGIC_OFFSET = 34;

// TTF и OTF делят один контейнер sfnt, отдельного маркера формата в нём нет: различает
// их версия sfnt, то есть тип обводов — 0x00010000 у TrueType (плюс "true" старых
// макинтошевских шрифтов и "ttcf" коллекций) против "OTTO" у CFF.
const signaturesByExtension: Record<Extension, Array<Signature>> = {
    [Extension.TTF]: [
        { offset: 0, bytes: [0x00, 0x01, 0x00, 0x00] },
        { offset: 0, bytes: asciiBytes("true") },
        { offset: 0, bytes: asciiBytes("ttcf") },
    ],
    [Extension.OTF]: [{ offset: 0, bytes: asciiBytes("OTTO") }],
    [Extension.WOFF]: [{ offset: 0, bytes: asciiBytes("wOFF") }],
    [Extension.WOFF2]: [{ offset: 0, bytes: asciiBytes("wOF2") }],
    [Extension.EOT]: [{ offset: EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
    // SVG — XML: фиксированной сигнатуры у него нет, формат опознаётся только разбором
    // текста. Пустой список означает «проверить нечем», и шрифт проходит по расширению.
    [Extension.SVG]: [],
};

export const FONT_SIGNATURE_HEAD_LENGTH = Object.values(signaturesByExtension)
    .flat()
    .reduce((length, signature) => Math.max(length, signature.offset + signature.bytes.length), 0);

export class FontSignature {
    /**
     * Совпадает ли начало файла с сигнатурой формата. Формат без известной сигнатуры
     * проверить нечем, такой шрифт считается совпавшим.
     */
    public static matches(head: Uint8Array, extension: Extension): boolean {
        const signatures = signaturesByExtension[extension];

        if (!signatures.length) {
            return true;
        }

        return signatures.some((signature) => {
            if (signature.offset + signature.bytes.length > head.length) {
                return false;
            }

            return signature.bytes.every((byte, index) => head[signature.offset + index] === byte);
        });
    }
}
