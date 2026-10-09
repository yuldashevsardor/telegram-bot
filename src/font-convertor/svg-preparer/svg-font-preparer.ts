import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { Encoding, SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { FileHelper } from "app/shared/fs/file-helper";
import { Tokens } from "app/shared/tokens";

// What one pass over the source finds. `advanceInsertionIndexes` are the indexes in the text where the
// start tag of a glyph element without an advance ends, before its `>` or `/>`; saxes counts its
// position in UTF-16 units, as the indexes of a string go. `unencodedGlyphIndexes` are what prepare()
// answers.
type GlyphScan = {
    fontAdvance: string | undefined;
    advanceInsertionIndexes: Array<number>;
    unencodedGlyphIndexes: Array<number>;
};

/**
 * Writes a copy of an SVG font that the engine reads as SVG 1.1 does. fontforge 20230101 misreads a
 * glyph that leaves `horiz-adv-x` out, which SVG 1.1 allows: such a glyph takes the advance of
 * `<font>` (§20.4), while fontforge gives it the em when `<font>` says 0, and drops it when it has no
 * `d` either. So the copy writes the advance of `<font>` on every `glyph` and `missing-glyph` that
 * leaves it out. Nothing else of the file changes, its times included, but a UTF-8 BOM, which XML
 * does not need.
 *
 * fontforge also encodes glyphs SVG 1.1 maps to no code point, and the text of the file cannot say
 * "no code point" to it. So the preparer answers with the indexes of those glyphs, and the engine
 * script takes their code points off (docs/architecture/font-convertor.md, "Reading SVG").
 *
 * The source has passed `SvgFontValidator`, and the preparer leans on its rules: the document is
 * XML, it holds one `font` with `horiz-adv-x`, the font nodes are SVG elements, and their attributes
 * are unprefixed. So the elements are matched by their local names, past the namespaces.
 */
@injectable()
export class SvgFontPreparer {
    private static readonly GLYPH_NAMES: ReadonlyArray<string> = ["glyph", "missing-glyph"];

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
        const glyphScan = this.scanGlyphs(sourcePath, sourceText);
        const preparedText = this.withGlyphAdvances(sourceText, glyphScan);

        await FileHelper.write(preparedPath, this.textCodec.encode(preparedText, encoding));
        // fontforge stamps the font it writes with the modification time of the file it reads, so the
        // result keeps the time of the source.
        await FileHelper.copyTimes(sourcePath, preparedPath);

        return glyphScan.unencodedGlyphIndexes;
    }

    private decode(sourcePath: string, sourceBytes: Uint8Array, encoding: Encoding): string {
        try {
            return this.textCodec.decode(sourceBytes, encoding);
        } catch (error) {
            throw UnpreparableSvgFont.byEncoding(sourcePath, error as Error);
        }
    }

    private scanGlyphs(sourcePath: string, sourceText: string): GlyphScan {
        // Without namespaces saxes does not need the prefixes the SVG 1.1 DTD fixes, which
        // SvgFontValidator binds itself.
        const parser = new SaxesParser<{ xmlns: false; forceXMLVersion: true; defaultXMLVersion: "1.0" }>({
            xmlns: false,
            forceXMLVersion: true,
            defaultXMLVersion: "1.0",
        });
        const openNames: Array<string> = [];
        const glyphScan: GlyphScan = { fontAdvance: undefined, advanceInsertionIndexes: [], unencodedGlyphIndexes: [] };
        let glyphElementIndex = 0;

        parser.on("error", () => {
            throw UnpreparableSvgFont.byParser(sourcePath);
        });
        parser.on("opentag", (tag) => {
            const name = this.localName(tag);
            const parentName = openNames.at(-1);

            openNames.push(name);

            if (name === "font") {
                glyphScan.fontAdvance = tag.attributes["horiz-adv-x"];
            }

            if (parentName !== "font" || !SvgFontPreparer.GLYPH_NAMES.includes(name)) {
                return;
            }

            if (tag.attributes["horiz-adv-x"] === undefined) {
                // The event comes once the closing `>` is read, and `/>` has no whitespace inside.
                glyphScan.advanceInsertionIndexes.push(parser.position - (tag.isSelfClosing ? "/>".length : ">".length));
            }

            if (this.isUnencoded(name, tag)) {
                glyphScan.unencodedGlyphIndexes.push(glyphElementIndex);
            }

            glyphElementIndex++;
        });
        parser.on("closetag", () => openNames.pop());

        parser.write(sourceText).close();

        return glyphScan;
    }

    private withGlyphAdvances(sourceText: string, glyphScan: GlyphScan): string {
        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (glyphScan.fontAdvance === undefined) {
            return sourceText;
        }

        const advanceAttribute = ` horiz-adv-x="${glyphScan.fontAdvance}"`;
        let preparedText = "";
        let copiedUpTo = 0;

        for (const insertionIndex of glyphScan.advanceInsertionIndexes) {
            preparedText += sourceText.slice(copiedUpTo, insertionIndex) + advanceAttribute;
            copiedUpTo = insertionIndex;
        }

        return preparedText + sourceText.slice(copiedUpTo);
    }

    // fontforge counts the characters of `unicode` as code points, so a character outside the BMP,
    // two UTF-16 units, is one. It reads no `unicode` of a `missing-glyph`, which SVG 1.1 does not
    // give it.
    private isUnencoded(name: string, tag: SaxesTagPlain): boolean {
        const unicode = tag.attributes["unicode"];

        return name === "missing-glyph" || unicode === undefined || [...unicode].length !== 1;
    }

    private localName(tag: SaxesTagPlain): string {
        return tag.name.slice(tag.name.indexOf(":") + 1);
    }
}
