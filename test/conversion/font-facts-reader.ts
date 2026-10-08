import path from "path";
import type { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { Extension } from "app/font-convertor/font-convertor.types";
import { RuntimeError } from "app/shared/errors";
import { ProcessHelper } from "app/shared/process/process-helper";
import type { FontFacts } from "test/conversion/font-facts-reader.types";

type FontFactsJson = Omit<FontFacts, "advanceWidths"> & { advanceWidths: Record<string, Array<number>> };

/**
 * Reads the facts of a font through fontforge: the image has fontforge with its embedded Python and
 * no separate python3.
 */
export class FontFactsReader {
    // The path is read from sys.argv, as in FontForge.convertScript. U+0000 is left out of the
    // encoded code points: it is the NULL control code, which no text draws, and the engine keeps it
    // in neither direction. Writing an sfnt, fontforge drops the cmap entry of U+0000 that points at
    // glyph 0, which an unmapped code point gets anyway. Reading an SVG, it gives U+0000 to glyph 0,
    // the <missing-glyph>, and to the `.null` glyph when the font has one, although neither has a
    // `unicode` attribute. An alternate encoding of a glyph (altuni) counts unless it goes with a
    // variation selector, and once: fontforge lists it once for every Unicode cmap subtable that
    // holds it, platform 0 and platform 3 of one font, which would read as two glyphs. A code point
    // that several glyphs share, as the `lang` variants of one character in an SVG font do, keeps
    // the width of each of them, so a change of any one shows. The widths are sorted, since the
    // glyph order differs between formats; two variants that swap their widths therefore pass
    // unseen.
    private readonly readScript = [
        "import fontforge, json, sys",
        "font = fontforge.open(sys.argv[1])",
        "glyphs = list(font.glyphs())",
        "widths = {}",
        "for glyph in glyphs:",
        "    codePoints = {glyph.unicode} | {alt[0] for alt in (glyph.altuni or ()) if alt[1] == -1}",
        "    for codePoint in codePoints:",
        "        if codePoint > 0:",
        "            widths.setdefault(codePoint, []).append(glyph.width)",
        "for codePointWidths in widths.values():",
        "    codePointWidths.sort()",
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
     * An EOT is unpacked into `workDir` first: fontforge cannot open the envelope. The unpacked file
     * is named apart from `<result>.ttf`, the intermediate font of the convertors into EOT.
     */
    public async read(fontPath: string, workDir: string): Promise<FontFacts> {
        let openedFontPath = fontPath;

        if (path.extname(fontPath).toLowerCase() === `.${Extension.EOT}`) {
            openedFontPath = path.join(workDir, `${path.basename(fontPath)}.unpacked.${Extension.TTF}`);
            await this.eotPacker.unpack(fontPath, openedFontPath);
        }

        // ProcessHelper.run leaves the maxBuffer of execFile at its default, 1 MiB of stdout: some 60 000
        // code points of `"<code point>": [<width>], `. A font with more fails with ProcessFailed.
        const { stdout, stderr } = await ProcessHelper.run(this.fontForgePath, ["-c", this.readScript, openedFontPath]);
        const factsJson = this.parseFacts(stdout, stderr, fontPath);
        const advanceWidths = new Map<number, Array<number>>();

        for (const [codePoint, widths] of Object.entries(factsJson.advanceWidths)) {
            advanceWidths.set(Number(codePoint), widths);
        }

        return { ...factsJson, advanceWidths: advanceWidths };
    }

    // stderr goes into the error too, with what fontforge said on opening the font. A Python exception
    // of readScript does not get here: fontforge exits with 1, and the ProcessFailed of
    // ProcessHelper.run carries stderr in its message.
    private parseFacts(stdout: string, stderr: string, fontPath: string): FontFactsJson {
        try {
            return JSON.parse(stdout) as FontFactsJson;
        } catch (error) {
            throw new RuntimeError("fontforge printed the facts of a font not as JSON", {
                fontPath: fontPath,
                stdout: stdout,
                stderr: stderr,
                cause: error,
            });
        }
    }
}
