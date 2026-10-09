import { injectable } from "inversify";
import type { Encoding } from "app/font-convertor/validator/svg/svg-font-validator.types";

/**
 * Reads the text of an SVG file and writes it back in the encoding it was read in. Two classes read
 * an SVG font: `SvgFontValidator` checks it, and `SvgFontPreparer` rewrites it for the engine. Both
 * read it the same way, so the encoding rule has one implementation.
 */
@injectable()
export class SvgTextCodec {
    // XML 1.0 §4.3.3 requires the BOM for UTF-16. Without one the file is read as UTF-8, and the
    // zero bytes of UTF-16 make it "not XML".
    private static readonly BYTE_ORDER_MARKS: Array<[number, number, Encoding]> = [
        [0xff, 0xfe, "utf-16le"],
        [0xfe, 0xff, "utf-16be"],
    ];
    private static readonly BYTE_ORDER_MARK = "﻿";

    public encodingOf(bytes: Uint8Array): Encoding {
        // A half-matching head is rejected under either decoder. UTF-8 never holds 0xFE or 0xFF, and
        // read as UTF-16 such a head does not open with `<`, whitespace or a BOM.
        // Stryker disable next-line LogicalOperator,ConditionalExpression: `||` and `true` for either comparison are equivalent: they change only the text of the NotXml that rejects a head with one byte of a BOM
        const mark = SvgTextCodec.BYTE_ORDER_MARKS.find(([first, second]) => bytes[0] === first && bytes[1] === second);

        return mark?.[2] ?? "utf-8";
    }

    /**
     * Throws the `TypeError` of `TextDecoder` on bytes outside the encoding: `fatal`, since such
     * bytes are a fatal error in XML (§4.3.3). The decoder drops the BOM of its own encoding.
     */
    public decode(bytes: Uint8Array, encoding: Encoding): string {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    }

    /**
     * Encodes the text as `decode()` read it: UTF-16 with its BOM, which `decode()` dropped. A BOM of
     * UTF-8, which `decode()` drops as well, is not written back: XML does not need it.
     */
    public encode(text: string, encoding: Encoding): Uint8Array {
        if (encoding === "utf-8") {
            return new TextEncoder().encode(text);
        }

        const littleEndianBytes = Buffer.from(SvgTextCodec.BYTE_ORDER_MARK + text, "utf16le");

        return encoding === "utf-16le" ? littleEndianBytes : littleEndianBytes.swap16();
    }
}
