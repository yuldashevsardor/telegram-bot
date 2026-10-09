import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { FontGlyph, FontScan, TextEdit, TextSpan } from "app/font-convertor/svg-preparer/svg-font-preparer.types";
import type { Encoding } from "app/font-convertor/validator/svg/svg-font-validator.types";
import type { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
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
 *   reads it under a presentation form, the one its table gives for that letter and form
 *   (`Unicode/ArabicForms.c`). An isolated form is what the letter shows alone, so when no glyph of
 *   the letter goes without `arabic-form`, the copy takes `arabic-form="isolated"` off, and fontforge
 *   reads the glyph under the letter. The table has no initial or medial form of U+0649 but the
 *   letter itself, so the copy writes those two under their presentation forms, U+FBE8 and U+FBE9,
 *   without `arabic-form`.
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
    // fontforge finds the presentation form of a letter by its Unicode name, "<letter> INITIAL FORM"
    // and so on (`makeutype.py`). These two forms of U+0649 are named after the languages that use
    // them, so its table maps them to the letter. By the Unicode 14 data of the image no other form
    // is missing from it.
    private static readonly ALEF_MAKSURA = "\u0649";
    private static readonly ALEF_MAKSURA_FORM_REFERENCES: ReadonlyMap<string, string> = new Map([
        ["initial", "&#xFBE8;"],
        ["medial", "&#xFBE9;"],
    ]);

    public constructor(@inject<SvgTextCodec>(Tokens.Font.Validator.SvgTextCodec) private readonly textCodec: SvgTextCodec) {}

    public async prepare(sourcePath: string, preparedPath: string): Promise<void> {
        const sourceBytes = await FileHelper.read(sourcePath);
        const encoding = this.textCodec.encodingOf(sourceBytes);
        const sourceText = this.decode(sourcePath, sourceBytes, encoding);

        await FileHelper.write(preparedPath, this.textCodec.encode(this.preparedText(sourcePath, sourceText), encoding));
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

    private preparedText(sourcePath: string, sourceText: string): string {
        const { fontAdvance, fontGlyphs } = this.scan(sourcePath, sourceText);

        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (fontAdvance === undefined) {
            return sourceText;
        }

        const lettersWithFormlessGlyph = this.lettersWithFormlessGlyph(fontGlyphs);
        const edits: Array<TextEdit> = [];

        for (const fontGlyph of fontGlyphs) {
            edits.push(...this.arabicFormEdits(fontGlyph, lettersWithFormlessGlyph));

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

    private lettersWithFormlessGlyph(fontGlyphs: ReadonlyArray<FontGlyph>): Set<string> {
        const letters = new Set<string>();

        for (const fontGlyph of fontGlyphs) {
            const letter = fontGlyph.attributes["unicode"];

            if (fontGlyph.name === "glyph" && letter !== undefined && fontGlyph.attributes["arabic-form"] === undefined) {
                letters.add(letter);
            }
        }

        return letters;
    }

    private arabicFormEdits(fontGlyph: FontGlyph, lettersWithFormlessGlyph: ReadonlySet<string>): Array<TextEdit> {
        const letter = fontGlyph.attributes["unicode"];
        const form = fontGlyph.attributes["arabic-form"];
        const letterSpan = fontGlyph.attributeSpans.get("unicode");
        const formSpan = fontGlyph.attributeSpans.get("arabic-form");

        if (letter === undefined || form === undefined || letterSpan === undefined || formSpan === undefined) {
            return [];
        }

        const formReference = letter === SvgFontPreparer.ALEF_MAKSURA ? SvgFontPreparer.ALEF_MAKSURA_FORM_REFERENCES.get(form) : undefined;

        if (formReference !== undefined) {
            return [
                { ...letterSpan, text: ` unicode="${formReference}"` },
                { ...formSpan, text: "" },
            ];
        }

        // fontforge reads the form of one code point only: a ligature keeps its attribute.
        const isLetter = [...letter].length === 1;

        if (form === "isolated" && isLetter && !lettersWithFormlessGlyph.has(letter)) {
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
