import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { FontGlyph, FontScan, TextEdit, TextSpan } from "app/font-convertor/svg-preparer/svg-font-preparer.types";
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

    public async prepare(sourcePath: string, preparedPath: string): Promise<void> {
        const sourceBytes = await FileHelper.read(sourcePath);
        const encoding = this.textCodec.encodingOf(sourceBytes);
        const sourceText = this.decode(sourcePath, sourceBytes, encoding);

        const preparedText = this.prepareText(sourcePath, sourceText);

        await FileHelper.write(preparedPath, this.textCodec.encode(preparedText, encoding));
        // fontforge stamps the font it writes with the modification time of the file it reads, so the
        // result keeps the time of the source.
        await FileHelper.copyTimes(sourcePath, preparedPath);
    }

    private decode(sourcePath: string, sourceBytes: Uint8Array, encoding: Encoding): string {
        try {
            return this.textCodec.decode(sourceBytes, encoding);
        } catch (error) {
            throw UnpreparableSvgFont.byEncoding(sourcePath, error as Error);
        }
    }

    private prepareText(sourcePath: string, sourceText: string): string {
        const { fontAdvance, fontGlyphs } = this.scan(sourcePath, sourceText);

        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (fontAdvance === undefined) {
            return sourceText;
        }

        // fontforge reads <missing-glyph> as .notdef, whatever its unicode and form say.
        const glyphs = fontGlyphs.filter((fontGlyph) => fontGlyph.name === "glyph");
        const presentationForms = this.presentationForms(glyphs);
        const readUnderLetter = this.unicodeValuesReadUnderLetter(glyphs, presentationForms);
        const edits: Array<TextEdit> = [];

        for (const glyph of glyphs) {
            edits.push(...this.arabicFormEdits(glyph, presentationForms, readUnderLetter));
        }

        for (const fontGlyph of fontGlyphs) {
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

    // The code point each initial or medial glyph of U+0649 goes under in the copy. A glyph already
    // under the presentation form keeps it alone, one this copy writes there included, and this one
    // stays under the letter, as fontforge reads it.
    private presentationForms(glyphs: ReadonlyArray<FontGlyph>): Map<FontGlyph, number> {
        const takenUnicodeValues = new Set<string>();
        const presentationForms = new Map<FontGlyph, number>();

        for (const glyph of glyphs) {
            const unicodeValue = glyph.attributes["unicode"];

            if (unicodeValue !== undefined) {
                takenUnicodeValues.add(unicodeValue);
            }
        }

        for (const glyph of glyphs) {
            const presentationFormCodePoint = this.alefMaksuraPresentationForm(glyph);

            if (presentationFormCodePoint === undefined) {
                continue;
            }

            const presentationForm = String.fromCodePoint(presentationFormCodePoint);

            if (takenUnicodeValues.has(presentationForm)) {
                continue;
            }

            takenUnicodeValues.add(presentationForm);
            presentationForms.set(glyph, presentationFormCodePoint);
        }

        return presentationForms;
    }

    // The `unicode` values fontforge reads some glyph of the copy under as they are written, with a form
    // or not.
    private unicodeValuesReadUnderLetter(glyphs: ReadonlyArray<FontGlyph>, presentationForms: ReadonlyMap<FontGlyph, number>): Set<string> {
        const readUnderLetter = new Set<string>();

        for (const glyph of glyphs) {
            const unicodeValue = glyph.attributes["unicode"];
            const form = glyph.attributes["arabic-form"];

            if (unicodeValue === undefined || presentationForms.has(glyph)) {
                continue;
            }

            const hasMovingForm = form !== undefined && SvgFontPreparer.ARABIC_FORMS.includes(form);
            // The table of fontforge maps them to the letter itself.
            const isAlefMaksuraFormLeftInPlace = this.alefMaksuraPresentationForm(glyph) !== undefined;

            if (!hasMovingForm || isAlefMaksuraFormLeftInPlace) {
                readUnderLetter.add(unicodeValue);
            }
        }

        return readUnderLetter;
    }

    private alefMaksuraPresentationForm(glyph: FontGlyph): number | undefined {
        const form = glyph.attributes["arabic-form"];

        if (glyph.attributes["unicode"] !== SvgFontPreparer.ALEF_MAKSURA || form === undefined) {
            return undefined;
        }

        return SvgFontPreparer.ALEF_MAKSURA_PRESENTATION_FORMS.get(form);
    }

    private arabicFormEdits(
        glyph: FontGlyph,
        presentationForms: ReadonlyMap<FontGlyph, number>,
        readUnderLetter: ReadonlySet<string>,
    ): Array<TextEdit> {
        const unicodeValue = glyph.attributes["unicode"];
        const form = glyph.attributes["arabic-form"];
        const unicodeSpan = glyph.attributeSpans.get("unicode");
        const formSpan = glyph.attributeSpans.get("arabic-form");

        if (unicodeValue === undefined || form === undefined || unicodeSpan === undefined || formSpan === undefined) {
            return [];
        }

        const presentationFormCodePoint = presentationForms.get(glyph);

        if (presentationFormCodePoint !== undefined) {
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

        if (form === "isolated" && isSingleCodePoint && !readUnderLetter.has(unicodeValue)) {
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
