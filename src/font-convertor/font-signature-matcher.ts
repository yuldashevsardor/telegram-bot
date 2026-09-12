import { injectable } from "inversify";
import { Extension } from "app/font-convertor/font-convertor.types";
import { ByteClass, Prefix, Signature, SignatureByte } from "app/font-convertor/font-signature-matcher.types";
import { SFNT_VERSIONS, sfntVersionBytes } from "app/font-convertor/sfnt-version";

@injectable()
export class FontSignatureMatcher {
    // У EOT нет сигнатуры в начале файла: заголовок открывается размерами шрифта, а
    // маркер формата (USHORT 0x504C, little-endian) лежит по фиксированному смещению.
    private static readonly EOT_MAGIC_OFFSET = 34;

    private static readonly UTF8_BOM = [0xef, 0xbb, 0xbf];
    // Пробельные символы XML: пробел, табуляция, перевод строки, возврат каретки.
    private static readonly XML_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d];
    // Предел отступа, BOM сверх него: без предела голова файла росла бы вместе с отступом.
    private static readonly MAX_INDENT_LENGTH = 16;

    // Чем документ разметки вправе открываться после `<`: буква корневого тега либо `!`
    // DOCTYPE и комментария.
    private static readonly EXCLAMATION_MARK = 0x21;
    private static readonly LETTER_RANGES: Array<[number, number]> = [
        [0x41, 0x5a],
        [0x61, 0x7a],
    ];
    // Граница управляющих байт C0: ниже неё лежит только управление, которого в тексте
    // нет (пробельные символы разметки проверяются отдельно). Выше границы проходит и
    // то, что текстом не является, — DEL и управляющие C1, — но отделить их не выйдет:
    // старшие байты нужны целиком, в них живёт UTF-8.
    private static readonly FIRST_NON_C0_BYTE = 0x20;
    // Сколько байт текста сигнатура требует за началом разметки. Одного `<` с буквой
    // мало: двоичная голова складывается в такую пару случайно — заголовок EOT
    // открывается размером файла, и у фикстуры его младшие байты дают `<m`. Дальше у
    // двоичного формата идут управляющие байты, у документа — текст.
    private static readonly MARKUP_TAIL_LENGTH = 10;

    private readonly signaturesByExtension: Record<Extension, Array<Signature>>;

    /**
     * Сколько байт от начала файла нужно прочитать, чтобы проверить любой формат.
     */
    public readonly headLength: number;

    public constructor() {
        // TTF и OTF лежат в одном контейнере sfnt, и по содержимому они неразличимы:
        // версия sfnt называет тип обводок, а не расширение имени. Обводки любого типа
        // законно встречаются под обоими расширениями, поэтому сигнатура здесь
        // подтверждает контейнер, а какую пару конвертации запускать — решает расширение.
        //
        // Набор версий общий с кодеком: какие версии домен принимает и почему среди них
        // нет коллекции ("ttcf"), сказано у `SFNT_VERSIONS`.
        const sfnt: Array<Signature> = SFNT_VERSIONS.map((version) => ({ offset: 0, bytes: sfntVersionBytes(version) }));

        this.signaturesByExtension = {
            [Extension.TTF]: sfnt,
            [Extension.OTF]: sfnt,
            [Extension.WOFF]: [{ offset: 0, bytes: this.ascii("wOFF") }],
            [Extension.WOFF2]: [{ offset: 0, bytes: this.ascii("wOF2") }],
            [Extension.EOT]: [{ offset: FontSignatureMatcher.EOT_MAGIC_OFFSET, bytes: [0x4c, 0x50] }],
            // SVG — единственный текстовый формат здесь, и его сигнатура слабее прочих:
            // она говорит «это разметка», а не «это шрифт». Разбирать документ домен не
            // станет, но и такой проверки хватает, чтобы двоичный мусор под именем
            // *.svg не прошёл.
            //
            // Поэтому вторая сигнатура ищет не корневой тег, а начало разметки вообще:
            // перед корневым тегом законны и `<!DOCTYPE`, и комментарий, а перечислять
            // прологи значило бы дописывать сигнатуру на каждый следующий.
            //
            // Первая сигнатура отдельно, потому что префикс у неё другой: объявление
            // XML обязано открывать документ, поэтому перед `<?xml` допустим только BOM
            // (fontforge файл с отступом перед объявлением не открывает), а перед любой
            // другой разметкой пробелы законны. По той же причине `?` не входит в класс
            // начала разметки: иначе отступ стал бы допустим и перед объявлением. Из-за
            // этого инструкция обработки классом не покрыта — проходит только та, что
            // начинается с `<?xml`, и только без отступа.
            [Extension.SVG]: [
                { offset: 0, bytes: this.ascii("<?xml"), prefix: Prefix.Bom },
                { offset: 0, bytes: [...this.ascii("<"), ByteClass.MarkupStart, ...this.markupTail()], prefix: Prefix.Indent },
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

            return signature.bytes.every((byte, index) => this.matchesByte(head[start + index], byte));
        });
    }

    private matchesByte(byte: number | undefined, expected: SignatureByte): boolean {
        if (byte === undefined) {
            return false;
        }

        if (typeof expected === "number") {
            return byte === expected;
        }

        switch (expected) {
            case ByteClass.MarkupStart:
                return this.isMarkupStart(byte);
            case ByteClass.Text:
                return this.isText(byte);
        }
    }

    private isMarkupStart(byte: number): boolean {
        const isLetter = FontSignatureMatcher.LETTER_RANGES.some(([from, to]) => byte >= from && byte <= to);

        return isLetter || byte === FontSignatureMatcher.EXCLAMATION_MARK;
    }

    private isText(byte: number): boolean {
        return byte >= FontSignatureMatcher.FIRST_NON_C0_BYTE || this.isXmlWhitespace(byte);
    }

    private markupTail(): Array<SignatureByte> {
        return Array.from({ length: FontSignatureMatcher.MARKUP_TAIL_LENGTH }, () => ByteClass.Text);
    }

    private prefixLength(head: Uint8Array, prefix?: Prefix): number {
        if (prefix === undefined) {
            return 0;
        }

        const bomLength = FontSignatureMatcher.UTF8_BOM.every((byte, index) => head[index] === byte)
            ? FontSignatureMatcher.UTF8_BOM.length
            : 0;

        switch (prefix) {
            case Prefix.Bom:
                return bomLength;
            case Prefix.Indent:
                // Отступ считается за BOM, а не вместе с ним: общий бюджет означал бы,
                // что невидимый BOM укорачивает допустимый отступ и один и тот же
                // документ из разных редакторов проходит проверку по-разному.
                return bomLength + this.indentLength(head, bomLength);
        }
    }

    private indentLength(head: Uint8Array, offset: number): number {
        let length = 0;

        while (length < FontSignatureMatcher.MAX_INDENT_LENGTH && this.isXmlWhitespace(head[offset + length])) {
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

    private maxPrefixLength(prefix?: Prefix): number {
        if (prefix === undefined) {
            return 0;
        }

        switch (prefix) {
            case Prefix.Bom:
                return FontSignatureMatcher.UTF8_BOM.length;
            case Prefix.Indent:
                return FontSignatureMatcher.UTF8_BOM.length + FontSignatureMatcher.MAX_INDENT_LENGTH;
        }
    }

    private ascii(text: string): Array<number> {
        return Array.from(text, (char) => char.charCodeAt(0));
    }
}
