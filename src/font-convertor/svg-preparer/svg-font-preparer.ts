import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { FontGlyph, FontScan, FontUnicodeValues, TextEdit, TextSpan } from "app/font-convertor/svg-preparer/svg-font-preparer.types";
import type { Encoding, SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { FileHelper } from "app/shared/fs/file-helper";
import { Tokens } from "app/shared/tokens";

/**
 * Writes a copy of an SVG font that the engine reads as SVG 1.1 does. fontforge 20230101 misreads
 * two things SVG 1.1 allows, and the copy works around both:
 *
 * - a glyph that leaves `horiz-adv-x` out takes the advance of `<font>` (§20.4), while fontforge
 *   gives it the em when `<font>` says 0, and drops it when it has no `d` either. So the copy writes
 *   the advance of `<font>` on every `glyph` and `missing-glyph` that leaves it out;
 * - a glyph with `arabic-form` is a form of the letter its `unicode` names (§20.5), while fontforge
 *   reads it under the presentation form its table gives, and does not know the form `terminal`. So
 *   the copy writes `terminal` as `final`, takes `arabic-form="isolated"` off a letter that has no
 *   glyph without a form, and writes the initial and medial forms of U+0649 under U+FBE8 and U+FBE9.
 *   Why each, in `docs/architecture/font-convertor.md`, "Reading SVG".
 *
 * Nothing else of the file changes, its times included, but a UTF-8 BOM, which XML does not need.
 *
 * fontforge also encodes glyphs SVG 1.1 maps to no code point, and the text of the file cannot say
 * "no code point" to it. So the preparer answers with the indexes of those glyphs, and the engine
 * script takes their code points off ("Reading SVG" again).
 *
 * The source has passed `SvgFontValidator`, and the preparer leans on its rules: the document is
 * XML, it holds one `font` with `horiz-adv-x`, the font nodes are SVG elements, and their attributes
 * are unprefixed. So the elements are matched by their local names, past the namespaces.
 */
@injectable()
export class SvgFontPreparer {
    private static readonly GLYPH_NAMES: ReadonlyArray<string> = ["glyph", "missing-glyph"];
    // The values of `arabic-form` that move a glyph off its letter in the copy; fontforge reads a
    // glyph with any other value under the letter, as one without the attribute.
    private static readonly ARABIC_FORMS: ReadonlyArray<string> = ["initial", "medial", "terminal", "final", "isolated"];
    private static readonly ALEF_MAKSURA = "\u0649";
    // The two forms the table of fontforge maps to the letter itself.
    private static readonly ALEF_MAKSURA_PRESENTATION_FORMS: ReadonlyMap<string, number> = new Map([
        ["initial", 0xfbe8],
        ["medial", 0xfbe9],
    ]);

    public constructor(@inject<SvgTextCodec>(Tokens.Font.Validator.SvgTextCodec) private readonly textCodec: SvgTextCodec) {}

    /**
     * Answers the indexes of the glyph elements SVG 1.1 maps to no code point, counting the `glyph`
     * and `missing-glyph` children of `<font>` in document order: every `missing-glyph`, and a `glyph`
     * whose `unicode` is not one character, which with several characters is a ligature of them
     * (§20.4, §20.5).
     */
    public async prepare(sourcePath: string, preparedPath: string): Promise<Array<number>> {
        const sourceBytes = await FileHelper.read(sourcePath);
        const encoding = this.textCodec.encodingOf(sourceBytes);
        const sourceText = this.decode(sourcePath, sourceBytes, encoding);
        const scan = this.scan(sourcePath, sourceText);

        const preparedText = this.prepareText(sourceText, scan);

        await FileHelper.write(preparedPath, this.textCodec.encode(preparedText, encoding));
        // fontforge stamps the font it writes with the modification time of the file it reads, so the
        // result keeps the time of the source.
        await FileHelper.copyTimes(sourcePath, preparedPath);

        return this.unencodedGlyphIndexes(scan.fontGlyphs);
    }

    private decode(sourcePath: string, sourceBytes: Uint8Array, encoding: Encoding): string {
        try {
            return this.textCodec.decode(sourceBytes, encoding);
        } catch (error) {
            throw UnpreparableSvgFont.byEncoding(sourcePath, error as Error);
        }
    }

    private prepareText(sourceText: string, scan: FontScan): string {
        const { fontAdvance, fontGlyphs } = scan;

        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (fontAdvance === undefined) {
            return sourceText;
        }

        const unicodeValues = this.unicodeValues(fontGlyphs);
        const edits: Array<TextEdit> = [];

        for (const fontGlyph of fontGlyphs) {
            edits.push(...this.arabicFormEdits(fontGlyph, unicodeValues));

            if (fontGlyph.attributes["horiz-adv-x"] === undefined) {
                const endIndex = fontGlyph.startTagEndIndex;
                edits.push({ fromIndex: endIndex, toIndex: endIndex, text: ` horiz-adv-x="${fontAdvance}"` });
            }
        }

        return this.edited(sourceText, edits);
    }

    private scan(sourcePath: string, sourceText: string): FontScan {
        // Without namespaces saxes does not need the prefixes the SVG 1.1 DTD fixes, which
        // SvgFontValidator binds itself.
        const parser = new SaxesParser<{ xmlns: false; forceXMLVersion: true; defaultXMLVersion: "1.0" }>({
            xmlns: false,
            forceXMLVersion: true,
            defaultXMLVersion: "1.0",
        });
        const openNames: Array<string> = [];
        const scan: FontScan = { fontAdvance: undefined, fontGlyphs: [] };
        // saxes counts its position in UTF-16 units, as the indexes of a string go.
        let attributeSpans = new Map<string, TextSpan>();
        let attributesEndIndex = 0;

        parser.on("error", () => {
            throw UnpreparableSvgFont.byParser(sourcePath);
        });
        parser.on("opentagstart", () => {
            // The event comes once the character after the name is read: whitespace, or the end of a
            // tag without attributes.
            attributeSpans = new Map();
            attributesEndIndex = parser.position;
        });
        parser.on("attribute", (attribute) => {
            // The event comes once the closing quote of the value is read, so an attribute reaches
            // back to the end of the one before it.
            attributeSpans.set(attribute.name, { fromIndex: attributesEndIndex, toIndex: parser.position });
            attributesEndIndex = parser.position;
        });
        parser.on("opentag", (tag) => {
            const name = this.localName(tag);
            const parentName = openNames.at(-1);

            openNames.push(name);

            if (name === "font") {
                scan.fontAdvance = tag.attributes["horiz-adv-x"];
            }

            if (parentName === "font" && SvgFontPreparer.GLYPH_NAMES.includes(name)) {
                scan.fontGlyphs.push({
                    name: name,
                    attributes: tag.attributes,
                    attributeSpans: attributeSpans,
                    // The event comes once the closing `>` is read, and `/>` has no whitespace inside.
                    startTagEndIndex: parser.position - (tag.isSelfClosing ? "/>".length : ">".length),
                });
            }
        });
        parser.on("closetag", () => openNames.pop());

        parser.write(sourceText).close();

        return scan;
    }

    private unencodedGlyphIndexes(fontGlyphs: ReadonlyArray<FontGlyph>): Array<number> {
        const unencodedGlyphIndexes: Array<number> = [];

        for (const [glyphIndex, fontGlyph] of fontGlyphs.entries()) {
            if (this.isUnencoded(fontGlyph)) {
                unencodedGlyphIndexes.push(glyphIndex);
            }
        }

        return unencodedGlyphIndexes;
    }

    // fontforge counts the characters of `unicode` as code points, so a character outside the BMP,
    // two UTF-16 units, is one. It reads <missing-glyph> as .notdef, whatever its unicode says.
    private isUnencoded(fontGlyph: FontGlyph): boolean {
        const unicodeValue = fontGlyph.attributes["unicode"];

        return fontGlyph.name !== "glyph" || unicodeValue === undefined || [...unicodeValue].length !== 1;
    }

    // fontforge reads <missing-glyph> as .notdef, whatever its unicode says.
    private unicodeValues(fontGlyphs: ReadonlyArray<FontGlyph>): FontUnicodeValues {
        const unicodeValues: FontUnicodeValues = { taken: new Set(), formless: new Set() };

        for (const fontGlyph of fontGlyphs) {
            const unicodeValue = fontGlyph.attributes["unicode"];
            const form = fontGlyph.attributes["arabic-form"];

            if (fontGlyph.name !== "glyph" || unicodeValue === undefined) {
                continue;
            }

            unicodeValues.taken.add(unicodeValue);

            if (form === undefined || !SvgFontPreparer.ARABIC_FORMS.includes(form)) {
                unicodeValues.formless.add(unicodeValue);
            }
        }

        return unicodeValues;
    }

    private arabicFormEdits(fontGlyph: FontGlyph, unicodeValues: FontUnicodeValues): Array<TextEdit> {
        const unicodeValue = fontGlyph.attributes["unicode"];
        const form = fontGlyph.attributes["arabic-form"];
        const unicodeSpan = fontGlyph.attributeSpans.get("unicode");
        const formSpan = fontGlyph.attributeSpans.get("arabic-form");

        if (unicodeValue === undefined || form === undefined || unicodeSpan === undefined || formSpan === undefined) {
            return [];
        }

        const presentationFormCodePoint =
            unicodeValue === SvgFontPreparer.ALEF_MAKSURA ? SvgFontPreparer.ALEF_MAKSURA_PRESENTATION_FORMS.get(form) : undefined;

        if (presentationFormCodePoint !== undefined) {
            const presentationForm = String.fromCodePoint(presentationFormCodePoint);

            // A glyph already under the presentation form keeps it alone, one this copy wrote there
            // included, and this one stays under the letter, as fontforge reads it.
            if (unicodeValues.taken.has(presentationForm)) {
                return [];
            }

            unicodeValues.taken.add(presentationForm);

            return [
                { ...unicodeSpan, text: ` unicode="&#x${presentationFormCodePoint.toString(16).toUpperCase()};"` },
                { ...formSpan, text: "" },
            ];
        }

        if (form === "terminal") {
            return [{ ...formSpan, text: ' arabic-form="final"' }];
        }

        // fontforge reads the form of one code point only: a ligature keeps its attribute.
        const isSingleCodePoint = [...unicodeValue].length === 1;

        if (form === "isolated" && isSingleCodePoint && !unicodeValues.formless.has(unicodeValue)) {
            return [{ ...formSpan, text: "" }];
        }

        return [];
    }

    private edited(sourceText: string, edits: ReadonlyArray<TextEdit>): string {
        // The edits do not overlap: each is an attribute of a start tag or the end of one.
        const editsInTextOrder = [...edits].sort((left, right) => left.fromIndex - right.fromIndex);
        let editedText = "";
        let copiedUpTo = 0;

        for (const edit of editsInTextOrder) {
            editedText += sourceText.slice(copiedUpTo, edit.fromIndex) + edit.text;
            copiedUpTo = edit.toIndex;
        }

        return editedText + sourceText.slice(copiedUpTo);
    }

    private localName(tag: SaxesTagPlain): string {
        return tag.name.slice(tag.name.indexOf(":") + 1);
    }
}
