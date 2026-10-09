import { inject, injectable } from "inversify";
import { SaxesParser } from "saxes";
import type { SaxesTagPlain } from "saxes";
import { UnpreparableSvgFont } from "app/font-convertor/svg-preparer/svg-font-preparer.errors";
import type { Encoding } from "app/font-convertor/validator/svg/svg-font-validator.types";
import type { SvgTextCodec } from "app/font-convertor/validator/svg/svg-text-codec";
import { FileHelper } from "app/shared/fs/file-helper";
import { Tokens } from "app/shared/tokens";

/**
 * Writes a copy of an SVG font that the engine reads as SVG 1.1 does. fontforge 20230101 misreads a
 * glyph that leaves `horiz-adv-x` out, which SVG 1.1 allows: such a glyph takes the advance of
 * `<font>` (§20.4), while fontforge gives it the em when `<font>` says 0, and drops it when it has no
 * `d` either. So the copy writes the advance of `<font>` on every `glyph` and `missing-glyph` that
 * leaves it out. Nothing else of the file changes, its times included, but a UTF-8 BOM, which XML
 * does not need.
 *
 * The source has passed `SvgFontValidator`, and the preparer leans on its rules: the document is
 * XML, it holds one `font` with `horiz-adv-x`, the font nodes are SVG elements, and their attributes
 * are unprefixed. So the elements are matched by their local names, past the namespaces.
 */
@injectable()
export class SvgFontPreparer {
    private static readonly GLYPH_NAMES: ReadonlyArray<string> = ["glyph", "missing-glyph"];

    public constructor(@inject<SvgTextCodec>(Tokens.Font.Svg.TextCodec) private readonly textCodec: SvgTextCodec) {}

    public async prepare(sourcePath: string, preparedPath: string): Promise<void> {
        const bytes = await FileHelper.read(sourcePath);
        const encoding = this.textCodec.encodingOf(bytes);
        const text = this.decode(sourcePath, bytes, encoding);

        await FileHelper.write(preparedPath, this.textCodec.encode(this.withGlyphAdvances(sourcePath, text), encoding));
        // fontforge stamps the font it writes with the modification time of the file it reads, so the
        // result keeps the time of the source.
        await FileHelper.copyTimes(sourcePath, preparedPath);
    }

    private decode(sourcePath: string, bytes: Uint8Array, encoding: Encoding): string {
        try {
            return this.textCodec.decode(bytes, encoding);
        } catch (error) {
            throw UnpreparableSvgFont.byEncoding(sourcePath, error as Error);
        }
    }

    private withGlyphAdvances(sourcePath: string, text: string): string {
        // Without namespaces saxes does not need the prefixes the SVG 1.1 DTD fixes, which
        // SvgFontValidator binds itself.
        const parser = new SaxesParser<{ xmlns: false; forceXMLVersion: true; defaultXMLVersion: "1.0" }>({
            xmlns: false,
            forceXMLVersion: true,
            defaultXMLVersion: "1.0",
        });
        const openNames: Array<string> = [];
        // The indexes in the text where the start tag of a glyph without an advance ends, before its
        // `>` or `/>`. saxes counts its position in UTF-16 units, as the indexes of a string go.
        const insertionIndexes: Array<number> = [];
        let fontAdvance: string | undefined;

        parser.on("error", () => {
            throw UnpreparableSvgFont.byParser(sourcePath);
        });
        parser.on("opentag", (tag) => {
            const name = this.localName(tag);
            const parentName = openNames.at(-1);

            openNames.push(name);

            if (name === "font") {
                fontAdvance = tag.attributes["horiz-adv-x"];
            }

            if (parentName === "font" && this.isGlyphWithoutAdvance(name, tag)) {
                // The event comes once the closing `>` is read, and `/>` has no whitespace inside.
                insertionIndexes.push(parser.position - (tag.isSelfClosing ? "/>".length : ">".length));
            }
        });
        parser.on("closetag", () => openNames.pop());

        parser.write(text).close();

        // SvgFontValidator requires `horiz-adv-x` of `font`.
        if (fontAdvance === undefined) {
            return text;
        }

        const advanceAttribute = ` horiz-adv-x="${fontAdvance}"`;
        let preparedText = "";
        let copiedUpTo = 0;

        for (const insertionIndex of insertionIndexes) {
            preparedText += text.slice(copiedUpTo, insertionIndex) + advanceAttribute;
            copiedUpTo = insertionIndex;
        }

        return preparedText + text.slice(copiedUpTo);
    }

    private isGlyphWithoutAdvance(name: string, tag: SaxesTagPlain): boolean {
        return SvgFontPreparer.GLYPH_NAMES.includes(name) && tag.attributes["horiz-adv-x"] === undefined;
    }

    private localName(tag: SaxesTagPlain): string {
        return tag.name.slice(tag.name.indexOf(":") + 1);
    }
}
