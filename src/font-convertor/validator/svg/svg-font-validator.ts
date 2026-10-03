import { injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagNS, XMLDecl } from "saxes";
import { FileHelper } from "app/shared/fs/file-helper";
import { isPathData } from "app/font-convertor/validator/svg/path-data";
import { BrokenFont, NoFont, NotSvg, NotXml } from "app/font-convertor/validator/svg/svg-font-validator.errors";
import type { Encoding, NumericElement, OpenElement, Scan, Violation } from "app/font-convertor/validator/svg/svg-font-validator.types";
import { FontRule } from "app/font-convertor/validator/svg/svg-font-validator.types";
import type { FontValidator } from "app/font-convertor/validator/font-validator";

/**
 * Checks an SVG font against W3C SVG 1.1 Second Edition, chapter 20 "Fonts". SVG 2 removed SVG
 * fonts, so 1.1 is the reference. Only the fonts are checked against it, not the rest of the
 * document. Three rules of ours look at the whole document: it holds one `font`, the names of the
 * font elements appear in it only on elements of the SVG namespace, and its DOCTYPE has no internal
 * subset.
 */
@injectable()
export class SvgFontValidator implements FontValidator {
    private static readonly SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    private static readonly XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
    private static readonly SVG_ROOT = `{${SvgFontValidator.SVG_NAMESPACE}}svg`;
    // The names fontforge reads by the local name alone: of an element in any namespace, and of a
    // processing instruction by its target (`_FindSVGFontNodes` and `SVGParseFont` of its `svg.c`).
    private static readonly FONT_NODE_NAMES: ReadonlyArray<string> = ["font", "font-face", "glyph", "missing-glyph"];

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

    // A quoted literal of a DOCTYPE: saxes pairs the quotes this way, so a bracket inside one is no
    // part of the markup.
    private static readonly QUOTED_LITERAL = /"[^"]*"|'[^']*'/g;

    // The attribute form of <number> (§4.2): unlike path data, `5.` is not a number here.
    private static readonly NUMBER = /^[+-]?(?:\d+|\d*\.\d+)(?:[Ee][+-]?\d+)?$/;
    // The attributes of type <number>: §20.4 for `glyph`, the same for `missing-glyph` (§20.5), and
    // the glyph origin on top of them for `font` (§20.3).
    private static readonly GLYPH_NUMERIC_ATTRIBUTES: ReadonlyArray<string> = [
        "horiz-adv-x",
        "vert-origin-x",
        "vert-origin-y",
        "vert-adv-y",
    ];
    private static readonly NUMERIC_ATTRIBUTES: Record<NumericElement, ReadonlyArray<string>> = {
        font: ["horiz-origin-x", "horiz-origin-y", ...SvgFontValidator.GLYPH_NUMERIC_ATTRIBUTES],
        glyph: SvgFontValidator.GLYPH_NUMERIC_ATTRIBUTES,
        "missing-glyph": SvgFontValidator.GLYPH_NUMERIC_ATTRIBUTES,
    };

    /**
     * Throws when the file is not a valid SVG font. The answers go in this order, each a subclass
     * of `InvalidSvgFont`: `NotXml`, `NotSvg`, `NoFont`, `BrokenFont`. A file that cannot be read
     * throws `ReadFailed` of `FileHelper` instead: an I/O failure, not a verdict on the font.
     */
    public async validate(fontPath: string): Promise<void> {
        const bytes = await FileHelper.read(fontPath);
        const encoding = this.encodingOf(bytes);
        const scan = this.scan(fontPath, this.decode(fontPath, bytes, encoding), encoding);

        if (scan.root !== SvgFontValidator.SVG_ROOT) {
            throw NotSvg.byRoot(fontPath, String(scan.root), SvgFontValidator.SVG_ROOT);
        }

        if (!scan.hasFont) {
            throw NoFont.inDocument(fontPath);
        }

        if (scan.violation !== undefined) {
            throw BrokenFont.byRule(fontPath, scan.violation);
        }
    }

    private encodingOf(bytes: Uint8Array): Encoding {
        // A half-matching head is rejected under either decoder. UTF-8 never holds 0xFE or 0xFF, and
        // read as UTF-16 such a head does not open with `<`, whitespace or a BOM.
        // Stryker disable next-line LogicalOperator,ConditionalExpression: `||` and `true` for either comparison are equivalent: they change only the text of the NotXml that rejects a head with one byte of a BOM
        const mark = SvgFontValidator.BYTE_ORDER_MARKS.find(([first, second]) => bytes[0] === first && bytes[1] === second);

        return mark?.[2] ?? "utf-8";
    }

    private decode(fontPath: string, bytes: Uint8Array, encoding: Encoding): string {
        // `fatal`: bytes that are not in the encoding are a fatal error in XML (§4.3.3). The decoder
        // drops the BOM of its own encoding.
        try {
            return new TextDecoder(encoding, { fatal: true }).decode(bytes);
        } catch (error) {
            throw NotXml.byEncoding(fontPath, encoding, error as Error);
        }
    }

    private scan(fontPath: string, text: string, encoding: Encoding): Scan {
        const scan: Scan = {
            svg11Doctype: false,
            root: undefined,
            hasFont: false,
            violation: undefined,
            open: [],
        };
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
            throw NotXml.byParser(fontPath, error);
        });
        parser.on("xmldecl", (declaration) => this.checkEncoding(parser, declaration, encoding));
        // The event comes at `>`, so the line is the one the DOCTYPE closes on.
        parser.on("doctype", (doctype) => this.checkDoctype(scan, doctype, parser.line));
        // The event comes once the name is read together with the character after it. A newline
        // there has already moved the line on, and the column back to zero.
        parser.on("opentagstart", () => {
            line = parser.column === 0 ? parser.line - 1 : parser.line;
        });
        parser.on("opentag", (tag) => this.open(scan, tag, line));
        // The event comes at `?>`, so the line is the one the instruction closes on.
        parser.on("processinginstruction", (instruction) => this.checkInstruction(scan, instruction.target, parser.line));
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

    private checkDoctype(scan: Scan, doctype: string, line: number): void {
        scan.svg11Doctype = SvgFontValidator.SVG11_DOCTYPE.test(doctype);

        // Our rule: fontforge takes attribute defaults from the internal subset (libxml2), and saxes
        // does not read it, so a default `d` of every glyph would pass unseen. The subset opens with
        // the first `[` outside the quoted literals of the external ID: a name holds no `[`. saxes
        // lets text after the subset through, so its end is no sign.
        // Stryker disable next-line StringLiteral: any replacement without `[` is equivalent: only whether a `[` is left counts
        if (doctype.replace(SvgFontValidator.QUOTED_LITERAL, "").includes("[")) {
            this.report(scan, FontRule.NoInternalSubset, "!DOCTYPE", line);
        }
    }

    private open(scan: Scan, tag: SaxesTagNS, line: number): void {
        const parent = scan.open.at(-1);
        const element: OpenElement = {
            name: tag.uri === SvgFontValidator.SVG_NAMESPACE ? tag.local : undefined,
            line: line,
            isGlyph: false,
            hasFontFace: false,
            hasGlyph: false,
        };

        if (parent === undefined) {
            scan.root = `{${tag.uri}}${tag.local}`;
        }

        scan.open.push(element);

        if (tag.uri !== SvgFontValidator.SVG_NAMESPACE && SvgFontValidator.FONT_NODE_NAMES.includes(tag.local)) {
            this.report(scan, FontRule.SvgNamespaceOnly, tag.local, line, { namespace: tag.uri });
        }

        // Our rule: without `d` fontforge draws a glyph from its children as any SVG, by the local
        // name and past the rules here, and next to `d` it drops them.
        if (parent?.isGlyph === true) {
            const namespace = element.name === undefined ? tag.uri : undefined;

            this.report(scan, FontRule.ChildlessGlyph, tag.local, line, { namespace: namespace });
        }

        // Of several fonts fontforge converts the first without a word. Which one to take is not the
        // domain's call, as with an sfnt collection.
        if (element.name === "font") {
            if (scan.hasFont) {
                this.report(scan, FontRule.SingleFont, "font", line);
            }

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
                element.isGlyph = true;
                this.checkGlyph(scan, element, tag, "glyph");
                break;
            case "missing-glyph":
                element.isGlyph = true;
                this.checkGlyph(scan, element, tag, "missing-glyph");
                break;
        }
    }

    private close(scan: Scan): void {
        const element = scan.open.pop();

        if (element?.name !== "font") {
            return;
        }

        if (!element.hasFontFace) {
            this.report(scan, FontRule.FontFaceRequired, "font", element.line);
        }

        if (!element.hasGlyph) {
            this.report(scan, FontRule.GlyphRequired, "font", element.line);
        }
    }

    private checkInstruction(scan: Scan, target: string, line: number): void {
        if (SvgFontValidator.FONT_NODE_NAMES.includes(target)) {
            this.report(scan, FontRule.SvgNamespaceOnly, `?${target}?`, line);
        }

        // libxml2 names a processing instruction by its target, so in a glyph `<?path?>` reaches
        // the same dispatch on the local name as a child element.
        if (scan.open.at(-1)?.isGlyph === true) {
            this.report(scan, FontRule.ChildlessGlyph, `?${target}?`, line);
        }
    }

    private checkFont(scan: Scan, element: OpenElement, tag: SaxesTagNS): void {
        this.checkPrefixes(scan, element, tag, "font");

        // `horiz-adv-x` of `font` is #REQUIRED in the DTD.
        if (tag.attributes["horiz-adv-x"] === undefined) {
            this.report(scan, FontRule.AdvanceRequired, "font", element.line);
        }

        this.checkMetrics(scan, element, tag, "font");
    }

    private checkFontFace(scan: Scan, element: OpenElement, tag: SaxesTagNS): void {
        this.checkPrefixes(scan, element, tag, "font-face");

        const unitsPerEm = tag.attributes["units-per-em"]?.value;

        // Our rule: the specification defaults `units-per-em` to 1000 (§20.8.3), but fontforge does
        // not open a font without it.
        if (unitsPerEm === undefined) {
            this.report(scan, FontRule.UnitsPerEmRequired, "font-face", element.line);
        } else if (!SvgFontValidator.NUMBER.test(unitsPerEm)) {
            this.report(scan, FontRule.Number, "font-face", element.line, { attribute: ["units-per-em", unitsPerEm] });
        } else if (this.sign(unitsPerEm) <= 0) {
            this.report(scan, FontRule.PositiveUnitsPerEm, "font-face", element.line, { attribute: ["units-per-em", unitsPerEm] });
        }
    }

    private checkGlyph(scan: Scan, element: OpenElement, tag: SaxesTagNS, name: Exclude<NumericElement, "font">): void {
        this.checkPrefixes(scan, element, tag, name);
        this.checkMetrics(scan, element, tag, name);

        const outline = tag.attributes["d"]?.value;

        if (outline !== undefined && !isPathData(outline)) {
            this.report(scan, FontRule.PathData, name, element.line, { attribute: ["d", outline] });
        }
    }

    /**
     * Checks the metrics: every attribute of type <number>, and that `horiz-adv-x` is not negative.
     */
    private checkMetrics(scan: Scan, element: OpenElement, tag: SaxesTagNS, name: NumericElement): void {
        for (const attribute of SvgFontValidator.NUMERIC_ATTRIBUTES[name]) {
            const value = tag.attributes[attribute]?.value;

            if (value !== undefined && !SvgFontValidator.NUMBER.test(value)) {
                this.report(scan, FontRule.Number, name, element.line, { attribute: [attribute, value] });
            }
        }

        const advance = tag.attributes["horiz-adv-x"]?.value;

        // "Glyph widths are required to be non-negative" (§20.3, §20.4).
        if (advance !== undefined && this.sign(advance) < 0) {
            this.report(scan, FontRule.NonNegativeAdvance, name, element.line, { attribute: ["horiz-adv-x", advance] });
        }
    }

    // The sign is read off the text of a number: `Number()` takes `1e-999` to zero.
    private sign(value: string): number {
        const mantissa = value.slice(0, value.search(/[Ee]|$/));

        if (!/[1-9]/.test(mantissa)) {
            return 0;
        }

        return mantissa.startsWith("-") ? -1 : 1;
    }

    /**
     * Our rule: a font node has no prefixed attribute. Only an unprefixed attribute is an attribute
     * of an SVG element, and the rules read it alone; saxes keys a prefixed one by its qualified
     * name. fontforge, though, reads the first attribute of a local name in any namespace (libxml2
     * `xmlGetProp`), so `x:unicode` before `unicode` maps the glyph to another character. A
     * namespace declaration is no attribute to libxml2.
     */
    private checkPrefixes(scan: Scan, element: OpenElement, tag: SaxesTagNS, name: string): void {
        for (const attribute of Object.values(tag.attributes)) {
            if (attribute.prefix !== "" && attribute.prefix !== "xmlns") {
                this.report(scan, FontRule.UnprefixedAttribute, name, element.line, { attribute: [attribute.name, attribute.value] });
            }
        }
    }

    private report(
        scan: Scan,
        rule: FontRule,
        name: string,
        line: number,
        details: Partial<Pick<Violation, "namespace" | "attribute">> = {},
    ): void {
        scan.violation ??= { rule: rule, element: name, namespace: details.namespace, line: line, attribute: details.attribute };
    }
}
