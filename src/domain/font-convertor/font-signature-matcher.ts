import { injectable } from "inversify";
import { Extension } from "app/domain/font-convertor/font-convertor.types";

type Signature = {
    offset: number;
    bytes: Array<number>;
};

// У EOT нет сигнатуры в начале файла: заголовок открывается размерами шрифта, а маркер
// формата (USHORT 0x504C, little-endian) лежит по фиксированному смещению.
const EOT_MAGIC_OFFSET = 34;

@injectable()
export class FontSignatureMatcher {
    private readonly signaturesByExtension: Record<Extension, Array<Signature>>;

    /**
     * Сколько байт от начала файла нужно прочитать, чтобы проверить любой формат.
     */
    public readonly headLength: number;

    public constructor() {
        // TTF и OTF лежат в одном контейнере sfnt, и по содержимому они неразличимы:
        // версия sfnt называет тип обводов (0x00010000 — TrueType, плюс "true" старых
        // макинтошевских шрифтов и "ttcf" коллекций; "OTTO" — CFF), а не расширение
        // имени. Обводки любого типа законно встречаются под обоими расширениями,
        // поэтому сигнатура здесь подтверждает контейнер, а какую пару конвертации
        // запускать — решает расширение.
        const sfnt: Array<Signature> = [
            { offset: 0, bytes: [0x00, 0x01, 0x00, 0x00] },
            { offset: 0, bytes: this.ascii("true") },
            { offset: 0, bytes: this.ascii("ttcf") },
            { offset: 0, bytes: this.ascii("OTTO") },
        ];

        this.signaturesByExtension = {
            [Extension.TTF]: sfnt,
            [Extension.OTF]: sfnt,
            [Extension.WOFF]: [{ offset: 0, bytes: this.ascii("wOFF") }],
            [Extension.WOFF2]: [{ offset: 0, bytes: this.ascii("wOF2") }],
            [Extension.EOT]: [{ offset: EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
            // SVG — единственный текстовый формат здесь, и его сигнатура слабее прочих:
            // она говорит «это XML», а не «это шрифт». Разбирать разметку домен не
            // станет, но и такой проверки хватает, чтобы бинарный мусор под именем
            // *.svg не прошёл.
            [Extension.SVG]: [
                { offset: 0, bytes: this.ascii("<?xml") },
                { offset: 0, bytes: this.ascii("<svg") },
            ],
        };

        this.headLength = this.calculateHeadLength();
    }

    /**
     * Совпадает ли начало файла с сигнатурой формата.
     */
    public matches(head: Uint8Array, extension: Extension): boolean {
        return this.signaturesByExtension[extension].some((signature) => {
            if (signature.offset + signature.bytes.length > head.length) {
                return false;
            }

            return signature.bytes.every((byte, index) => head[signature.offset + index] === byte);
        });
    }

    private calculateHeadLength(): number {
        const signatures = Object.values(this.signaturesByExtension).flat();

        return signatures.reduce((length, signature) => Math.max(length, signature.offset + signature.bytes.length), 0);
    }

    private ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
