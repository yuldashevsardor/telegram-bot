import { injectable } from "inversify";
import { Extension } from "app/domain/font-convertor/font-convertor.types";
import { Prefix, Signature } from "app/domain/font-convertor/font-signature-matcher.types";

@injectable()
export class FontSignatureMatcher {
    // У EOT нет сигнатуры в начале файла: заголовок открывается размерами шрифта, а
    // маркер формата (USHORT 0x504C, little-endian) лежит по фиксированному смещению.
    private static readonly EOT_MAGIC_OFFSET = 34;

    private static readonly UTF8_BOM = [0xef, 0xbb, 0xbf];
    // Пробельные символы XML: пробел, табуляция, перевод строки, возврат каретки.
    private static readonly XML_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d];
    // Предел всего префикса, вместе с BOM: без него голова файла росла бы вместе с отступом.
    private static readonly MAX_INDENT_LENGTH = 16;

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
            [Extension.EOT]: [{ offset: FontSignatureMatcher.EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
            // SVG — единственный текстовый формат здесь, и его сигнатура слабее прочих:
            // она говорит «это XML», а не «это шрифт». Разбирать разметку домен не
            // станет, но и такой проверки хватает, чтобы бинарный мусор под именем
            // *.svg не прошёл.
            //
            // Пропускаемый префикс у двух сигнатур разный, и разный он у самого XML:
            // объявление обязано открывать документ, поэтому перед `<?xml` допустим
            // только BOM (fontforge файл с отступом перед объявлением не открывает), а
            // перед корневым тегом документа без объявления пробелы законны.
            [Extension.SVG]: [
                { offset: 0, bytes: this.ascii("<?xml"), prefix: Prefix.Bom },
                { offset: 0, bytes: this.ascii("<svg"), prefix: Prefix.Indent },
            ],
        };

        this.headLength = this.calculateHeadLength();
    }

    /**
     * Совпадает ли начало файла с сигнатурой формата.
     */
    public matches(head: Uint8Array, extension: Extension): boolean {
        return this.signaturesByExtension[extension].some((signature) => {
            const start = this.prefixLength(head, signature.prefix) + signature.offset;

            if (start + signature.bytes.length > head.length) {
                return false;
            }

            return signature.bytes.every((byte, index) => head[start + index] === byte);
        });
    }

    /**
     * Сколько байт занял префикс этого вида в начале головы файла.
     */
    private prefixLength(head: Uint8Array, prefix: Prefix = Prefix.None): number {
        if (prefix === Prefix.None) {
            return 0;
        }

        let length = FontSignatureMatcher.UTF8_BOM.every((byte, index) => head[index] === byte) ? FontSignatureMatcher.UTF8_BOM.length : 0;

        if (prefix === Prefix.Bom) {
            return length;
        }

        while (length < FontSignatureMatcher.MAX_INDENT_LENGTH && this.isXmlWhitespace(head[length])) {
            length += 1;
        }

        return length;
    }

    private isXmlWhitespace(byte: number | undefined): boolean {
        return byte !== undefined && FontSignatureMatcher.XML_WHITESPACE.includes(byte);
    }

    private calculateHeadLength(): number {
        const signatures = Object.values(this.signaturesByExtension).flat();

        // Пропущенный префикс сокращает полезную часть головы, поэтому к сигнатуре
        // добавляется предельная длина её префикса.
        return signatures.reduce(
            (length, signature) => Math.max(length, this.maxPrefixLength(signature.prefix) + signature.offset + signature.bytes.length),
            0,
        );
    }

    private maxPrefixLength(prefix: Prefix = Prefix.None): number {
        switch (prefix) {
            case Prefix.None:
                return 0;
            case Prefix.Bom:
                return FontSignatureMatcher.UTF8_BOM.length;
            case Prefix.Indent:
                return FontSignatureMatcher.MAX_INDENT_LENGTH;
        }
    }

    private ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
