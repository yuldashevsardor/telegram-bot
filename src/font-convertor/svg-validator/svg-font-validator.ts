import { injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagNS, XMLDecl } from "saxes";
import { FileHelper } from "app/shared/fs/file-helper";
import { BrokenFont, NoFont, NotSvg, NotXml } from "app/font-convertor/svg-validator/svg-font-validator.errors";
import type { Encoding, OpenElement, Scan } from "app/font-convertor/svg-validator/svg-font-validator.types";
import { FontRule } from "app/font-convertor/svg-validator/svg-font-validator.types";

/**
 * Checks an SVG font against W3C SVG 1.1 Second Edition, chapter 20 "Fonts". SVG 2 removed SVG
 * fonts, so 1.1 is the reference. Only the fonts are checked against it, not the rest of the
 * document. The path data of `d` is not checked yet (#611).
 */
@injectable()
export class SvgFontValidator {
    private static readonly SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    private static readonly XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
    private static readonly SVG_ROOT = `{${SvgFontValidator.SVG_NAMESPACE}}svg`;

    // XML 1.0 §4.3.3 requires the BOM for UTF-16. Without one the file is read as UTF-8, and the
    // zero bytes of UTF-16 make it "not XML".
    private static readonly BYTE_ORDER_MARKS: Array<[number, number, Encoding]> = [
        [0xff, 0xfe, "utf-16le"],
        [0xfe, 0xff, "utf-16be"],
    ];
    // The names an encoding declaration may give to the encoding the file is read in; any other
    // name makes the file "not XML".
    private static readonly DECLARED_ENCODINGS: Record<Encoding, Array<string>> = {
        "utf-8": ["utf-8"],
        "utf-16le": ["utf-16", "utf-16le"],
        "utf-16be": ["utf-16", "utf-16be"],
    };

    // The SVG 1.1 DTD declares `xmlns` and `xmlns:xlink` of `svg` #FIXED (`SVG.xmlns.attrib`,
    // Appendix A.3.3), so under this DOCTYPE a document may leave both out. Font Awesome 4.7 has no
    // `xmlns`.
    private static readonly SVG11_DOCTYPE = /PUBLIC\s+["']-\/\/W3C\/\/DTD SVG 1\.1\/\/EN["']/;
    private static readonly SVG11_DOCTYPE_NAMESPACES = new Map([
        ["", SvgFontValidator.SVG_NAMESPACE],
        ["xlink", SvgFontValidator.XLINK_NAMESPACE],
    ]);

    // The attribute form of <number> (§4.2): unlike path data, `5.` is not a number here.
    private static readonly NUMBER = /^[+-]?(?:\d+|\d*\.\d+)(?:[Ee][+-]?\d+)?$/;
    // The attributes of type <number>: §20.3 for `font`, §20.4 for `glyph`; `missing-glyph` has the
    // attributes of `glyph` (§20.5).
    private static readonly NUMERIC_ATTRIBUTES: Record<"font" | "glyph" | "missing-glyph", Array<string>> = {
        font: ["horiz-origin-x", "horiz-origin-y", "horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
        glyph: ["horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
        "missing-glyph": ["horiz-adv-x", "vert-origin-x", "vert-origin-y", "vert-adv-y"],
    };

    /**
     * Throws when the file is not a valid SVG font. The answers go in this order, each a subclass
     * of `InvalidSvgFont`: `NotXml`, `NotSvg`, `NoFont`, `BrokenFont`.
     */
    public async validate(path: string): Promise<void> {
        const bytes = await FileHelper.read(path);
        const encoding = this.encodingOf(bytes);
        const scan = this.scan(this.decode(bytes, encoding), encoding);

        if (scan.root !== SvgFontValidator.SVG_ROOT) {
            throw NotSvg.byRoot(String(scan.root), SvgFontValidator.SVG_ROOT);
        }

        if (!scan.hasFont) {
            throw NoFont.inDocument();
        }

        if (scan.violation !== undefined) {
            throw scan.violation;
        }
    }

    private encodingOf(bytes: Uint8Array): Encoding {
        // A half-matching head is rejected under either decoder. UTF-8 never holds 0xFE or 0xFF, and
        // read as UTF-16 such a head does not open with `<`, whitespace or a BOM.
        // Stryker disable next-line LogicalOperator,ConditionalExpression: `||` and `true` for either comparison are equivalent: they change only the text of the NotXml that rejects a head with one byte of a BOM
        const mark = SvgFontValidator.BYTE_ORDER_MARKS.find(([first, second]) => bytes[0] === first && bytes[1] === second);

        return mark?.[2] ?? "utf-8";
    }

    private decode(bytes: Uint8Array, encoding: Encoding): string {
        // `fatal`: bytes that are not in the encoding are a fatal error in XML (§4.3.3). The decoder
        // drops the BOM of its own encoding.
        try {
            return new TextDecoder(encoding, { fatal: true }).decode(bytes);
        } catch (error) {
            throw NotXml.byEncoding(encoding, error as Error);
        }
    }

    private scan(text: string, encoding: Encoding): Scan {
        const scan: Scan = { svg11Doctype: false, root: undefined, hasFont: false, violation: undefined, open: [] };
        // XML 1.0 fifth edition: a document declaring another 1.x version is read as 1.0.
        const parser = new SaxesParser({
            xmlns: true,
            forceXMLVersion: true,
            defaultXMLVersion: "1.0",
            // saxes does not read the DTD, so the prefixes it fixes are bound here.
            resolvePrefix: (prefix: string): string | undefined =>
                scan.svg11Doctype ? SvgFontValidator.SVG11_DOCTYPE_NAMESPACES.get(prefix) : undefined,
        });
        let line = 0;

        // Without a handler saxes throws its own bare Error on the first error.
        parser.on("error", (error) => {
            throw NotXml.byParser(error);
        });
        parser.on("xmldecl", (declaration) => this.checkEncoding(parser, declaration, encoding));
        parser.on("doctype", (doctype) => {
            scan.svg11Doctype = SvgFontValidator.SVG11_DOCTYPE.test(doctype);
        });
        // The event comes once the name is read together with the character after it. A newline
        // there has already moved the line on, and the column back to zero.
        parser.on("opentagstart", () => {
            line = parser.column === 0 ? parser.line - 1 : parser.line;
        });
        parser.on("opentag", (tag) => this.open(scan, tag, line));
        parser.on("closetag", () => this.close(scan));

        parser.write(text).close();

        return scan;
    }

    private checkEncoding(parser: SaxesParser, declaration: XMLDecl, encoding: Encoding): void {
        const declared = declaration.encoding;

        if (declared !== undefined && !SvgFontValidator.DECLARED_ENCODINGS[encoding].includes(declared.toLowerCase())) {
            parser.fail(`the encoding declaration names ${declared}, while the file is read as ${encoding}.`);
        }
    }

    private open(scan: Scan, tag: SaxesTagNS, line: number): void {
        const parent = scan.open.at(-1);
        const element: OpenElement = {
            name: tag.uri === SvgFontValidator.SVG_NAMESPACE ? tag.local : undefined,
            line: line,
            hasFontFace: false,
            hasGlyph: false,
        };

        if (parent === undefined) {
            scan.root = `{${tag.uri}}${tag.local}`;
        }

        scan.open.push(element);

        if (element.name === "font") {
            scan.hasFont = true;
            this.checkFont(scan, element, tag);
        }

        // `font-face` and `glyph` count only as direct children of `font`: its content model (§20.3).
        if (parent?.name !== "font") {
            return;
        }

        switch (element.name) {
            case "font-face":
                parent.hasFontFace = true;
                this.checkFontFace(scan, element, tag);
                break;
            case "glyph":
                parent.hasGlyph = true;
                this.checkNumbers(scan, element, tag, element.name);
                this.checkAdvance(scan, element, tag, element.name);
                break;
            case "missing-glyph":
                this.checkNumbers(scan, element, tag, element.name);
                this.checkAdvance(scan, element, tag, element.name);
                break;
        }
    }

    private close(scan: Scan): void {
        const element = scan.open.pop();

        if (element?.name !== "font") {
            return;
        }

        if (!element.hasFontFace) {
            this.report(scan, FontRule.FontFaceRequired, element.name, element.line);
        }

        if (!element.hasGlyph) {
            this.report(scan, FontRule.GlyphRequired, element.name, element.line);
        }
    }

    private checkFont(scan: Scan, element: OpenElement, tag: SaxesTagNS): void {
        // `horiz-adv-x` of `font` is #REQUIRED in the DTD.
        if (this.attribute(tag, "horiz-adv-x") === undefined) {
            this.report(scan, FontRule.AdvanceRequired, "font", element.line);
        }

        this.checkNumbers(scan, element, tag, "font");
        this.checkAdvance(scan, element, tag, "font");
    }

    private checkFontFace(scan: Scan, element: OpenElement, tag: SaxesTagNS): void {
        const unitsPerEm = this.attribute(tag, "units-per-em");

        // Our rule: the specification defaults `units-per-em` to 1000 (§20.8.3), but fontforge does
        // not open a font without it.
        if (unitsPerEm === undefined) {
            this.report(scan, FontRule.UnitsPerEmRequired, "font-face", element.line);
        } else if (!SvgFontValidator.NUMBER.test(unitsPerEm)) {
            this.report(scan, FontRule.Number, "font-face", element.line, ["units-per-em", unitsPerEm]);
        } else if (this.sign(unitsPerEm) <= 0) {
            this.report(scan, FontRule.PositiveUnitsPerEm, "font-face", element.line, ["units-per-em", unitsPerEm]);
        }
    }

    private checkNumbers(scan: Scan, element: OpenElement, tag: SaxesTagNS, name: "font" | "glyph" | "missing-glyph"): void {
        for (const attribute of SvgFontValidator.NUMERIC_ATTRIBUTES[name]) {
            const value = this.attribute(tag, attribute);

            if (value !== undefined && !SvgFontValidator.NUMBER.test(value)) {
                this.report(scan, FontRule.Number, name, element.line, [attribute, value]);
            }
        }
    }

    private checkAdvance(scan: Scan, element: OpenElement, tag: SaxesTagNS, name: string): void {
        const advance = this.attribute(tag, "horiz-adv-x");

        // "Glyph widths are required to be non-negative" (§20.3, §20.4).
        if (advance !== undefined && this.sign(advance) < 0) {
            this.report(scan, FontRule.NonNegativeAdvance, name, element.line, ["horiz-adv-x", advance]);
        }
    }

    // The sign is read off the text of a number: `Number()` takes `1e-999` to zero.
    private sign(value: string): number {
        const mantissa = value.replace(/[Ee].*/, "");

        if (!/[1-9]/.test(mantissa)) {
            return 0;
        }

        return mantissa.startsWith("-") ? -1 : 1;
    }

    private attribute(tag: SaxesTagNS, name: string): string | undefined {
        // Only an unprefixed attribute is an attribute of an SVG element; saxes keys a prefixed one
        // by its qualified name.
        return tag.attributes[name]?.value;
    }

    private report(scan: Scan, rule: FontRule, name: string, line: number, attribute?: [string, string]): void {
        scan.violation ??= BrokenFont.byRule(rule, name, line, attribute);
    }
}
