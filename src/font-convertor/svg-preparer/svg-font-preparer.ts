import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { Encoding } from "app/font-convertor/validator/svg/svg-font-validator.types";
import type { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { FileHelper } from "app/shared/fs/file-helper";
import { Tokens } from "app/shared/tokens";

// What one pass over the source finds. `advanceInsertionIndexes` are the indexes in the text where the
// start tag of a font node without an advance ends, before its `>` or `/>`; saxes counts its position
// in UTF-16 units, as the indexes of a string go. `unencodedIndexes` are what prepare() answers.
type FontNodes = {
    fontAdvance: string | undefined;
    advanceInsertionIndexes: Array<number>;
    unencodedIndexes: Array<number>;
};

/**
 * Writes a copy of an SVG font that the engine reads as SVG 1.1 does. fontforge 20230101 misreads a
 * glyph that leaves `horiz-adv-x` out, which SVG 1.1 allows: such a glyph takes the advance of
 * `<font>` (§20.4), while fontforge gives it the em when `<font>` says 0, and drops it when it has no
 * `d` either. So the copy writes the advance of `<font>` on every `glyph` and `missing-glyph` that
 * leaves it out. Nothing else of the file changes, its times included, but a UTF-8 BOM, which XML
 * does not need.
 *
 * fontforge also gives a code point to a font node that SVG 1.1 maps to none, and the text of the
 * file cannot say "no code point" to it. So the preparer answers with the indexes of those nodes
 * and the engine script takes their code points off (`FontForge`).
 *
 * The source has passed `SvgFontValidator`, and the preparer leans on its rules: the document is
 * XML, it holds one `font` with `horiz-adv-x`, the font nodes are SVG elements, and their attributes
 * are unprefixed. So the elements are matched by their local names, past the namespaces.
 */
@injectable()
export class SvgFontPreparer {
    private static readonly FONT_NODE_NAMES: ReadonlyArray<string> = ["glyph", "missing-glyph"];

    public constructor(@inject<SvgTextCodec>(Tokens.Font.Validator.SvgTextCodec) private readonly textCodec: SvgTextCodec) {}

    /**
     * Answers the indexes of the font nodes that SVG 1.1 maps to no code point, the `glyph` and
     * `missing-glyph` children of `<font>` counted in document order: every `missing-glyph`, and a
     * `glyph` whose `unicode` is not one character, which with several characters is a ligature of
     * them (§20.4, §20.5). fontforge 20230101 gives each of them a code point all the same: U+0000 to
     * a `missing-glyph`, the code point of its ligature to a `glyph` that has one (`unicode="fi"`
     * U+FB01), and otherwise the one its `glyph-name` spells (`Ldot` U+013F, `uni0041` U+0041 beside
     * the glyph of `A`). It numbers the nodes in the same order, as `originalgid`, counting the ones
     * it drops too, so an index names the glyph whatever name fontforge gives it.
     */
    public async prepare(sourcePath: string, preparedPath: string): Promise<Array<number>> {
        const sourceBytes = await FileHelper.read(sourcePath);
        const encoding = this.textCodec.encodingOf(sourceBytes);
        const sourceText = this.decode(sourcePath, sourceBytes, encoding);
        const fontNodes = this.readFontNodes(sourcePath, sourceText);
        const preparedText = this.withGlyphAdvances(sourceText, fontNodes);

        await FileHelper.write(preparedPath, this.textCodec.encode(preparedText, encoding));
        // fontforge stamps the font it writes with the modification time of the file it reads, so the
        // result keeps the time of the source.
        await FileHelper.copyTimes(sourcePath, preparedPath);

        return fontNodes.unencodedIndexes;
    }

    private decode(sourcePath: string, sourceBytes: Uint8Array, encoding: Encoding): string {
        try {
            return this.textCodec.decode(sourceBytes, encoding);
        } catch (error) {
            throw UnpreparableSvgFont.byEncoding(sourcePath, error as Error);
        }
    }

    private readFontNodes(sourcePath: string, sourceText: string): FontNodes {
        // Without namespaces saxes does not need the prefixes the SVG 1.1 DTD fixes, which
        // SvgFontValidator binds itself.
        const parser = new SaxesParser<{ xmlns: false; forceXMLVersion: true; defaultXMLVersion: "1.0" }>({
            xmlns: false,
            forceXMLVersion: true,
            defaultXMLVersion: "1.0",
        });
        const openNames: Array<string> = [];
        const fontNodes: FontNodes = { fontAdvance: undefined, advanceInsertionIndexes: [], unencodedIndexes: [] };
        let fontNodeCount = 0;

        parser.on("error", () => {
            throw UnpreparableSvgFont.byParser(sourcePath);
        });
        parser.on("opentag", (tag) => {
            const name = this.localName(tag);
            const parentName = openNames.at(-1);

            openNames.push(name);

            if (name === "font") {
                fontNodes.fontAdvance = tag.attributes["horiz-adv-x"];
            }

            if (parentName !== "font" || !SvgFontPreparer.FONT_NODE_NAMES.includes(name)) {
                return;
            }

            if (tag.attributes["horiz-adv-x"] === undefined) {
                // The event comes once the closing `>` is read, and `/>` has no whitespace inside.
                fontNodes.advanceInsertionIndexes.push(parser.position - (tag.isSelfClosing ? "/>".length : ">".length));
            }

            if (this.isUnencoded(name, tag)) {
                fontNodes.unencodedIndexes.push(fontNodeCount);
            }

            fontNodeCount++;
        });
        parser.on("closetag", () => openNames.pop());

        parser.write(sourceText).close();

        return fontNodes;
    }

    private withGlyphAdvances(sourceText: string, fontNodes: FontNodes): string {
        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (fontNodes.fontAdvance === undefined) {
            return sourceText;
        }

        const advanceAttribute = ` horiz-adv-x="${fontNodes.fontAdvance}"`;
        let preparedText = "";
        let copiedUpTo = 0;

        for (const insertionIndex of fontNodes.advanceInsertionIndexes) {
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
