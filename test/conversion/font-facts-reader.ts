import path from "path";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { ProcessHelper } from "app/shared/process/process-helper";
import type { FontFacts } from "test/conversion/font-facts-reader.types";

type FontFactsJson = Omit<FontFacts, "advanceWidths"> & { advanceWidths: Record<string, number> };

/**
 * Reads the facts of a font through fontforge: the image has fontforge with its embedded Python and
 * no separate python3.
 */
export class FontFactsReader {
    // The path is read from sys.argv, as in FontForge.convertScript. U+0000 is left out of the
    // encoded code points: it is the NULL control code, which no text draws, and the engine keeps it
    // in neither direction. Writing an sfnt, fontforge drops the cmap entry of U+0000 that points at
    // glyph 0, which an unmapped code point gets anyway; reading an SVG, it gives U+0000 by name to
    // the `.null` glyph, which has no `unicode` attribute. An alternate encoding of a glyph (altuni)
    // counts unless it goes with a variation selector.
    private readonly readScript = [
        "import fontforge, json, sys",
        "font = fontforge.open(sys.argv[1])",
        "glyphs = list(font.glyphs())",
        "widths = {}",
        "for glyph in glyphs:",
        "    codePoints = [glyph.unicode] + [alt[0] for alt in (glyph.altuni or ()) if alt[1] == -1]",
        "    for codePoint in codePoints:",
        "        if codePoint > 0:",
        "            widths[codePoint] = glyph.width",
        "print(json.dumps({",
        '    "glyphCount": len(glyphs),',
        '    "familyName": font.familyname,',
        '    "unitsPerEm": font.em,',
        '    "ascent": font.ascent,',
        '    "descent": font.descent,',
        '    "advanceWidths": widths,',
        "}))",
    ].join("\n");

    public constructor(private readonly eotPacker: EotPacker, private readonly fontForgePath: string) {}

    /**
     * An EOT is unpacked into `workDir` first: fontforge cannot open the envelope.
     */
    public async read(fontPath: string, workDir: string): Promise<FontFacts> {
        let sfntPath = fontPath;

        if (path.extname(fontPath).toLowerCase() === `.${Extension.EOT}`) {
            sfntPath = path.join(workDir, `${path.basename(fontPath)}.${Extension.TTF}`);
            await this.eotPacker.unpack(fontPath, sfntPath);
        }

        const { stdout } = await ProcessHelper.run(this.fontForgePath, ["-c", this.readScript, sfntPath]);
        const factsJson = JSON.parse(stdout) as FontFactsJson;
        const advanceWidths = new Map<number, number>();

        for (const [codePoint, width] of Object.entries(factsJson.advanceWidths)) {
            advanceWidths.set(Number(codePoint), width);
        }

        return { ...factsJson, advanceWidths: advanceWidths };
    }
}
