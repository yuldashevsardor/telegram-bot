import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessHelper } from "app/shared/process/process-helper";
import { inject, injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { configValue } from "app/shared/config-value";
import type { SvgFontPreparer } from "app/font-convertor/svg-preparer/svg-font-preparer";
import { Tokens } from "app/shared/tokens";

@injectable()
export class FontForge {
    // EOT is left out on purpose: the engine does not read the envelope, and on writing it
    // silently puts PostScript Type 1 under the .eot name (docs/architecture/invariants.md).
    // EotPacker takes the envelope off and puts it on, so on an EOT route the engine reads or writes
    // a plain sfnt, never the envelope (issue https://github.com/yuldashevsardor/telegram-bot/issues/158).
    private readonly supportedExtensions = [Extension.OTF, Extension.TTF, Extension.WOFF, Extension.SVG, Extension.WOFF2];
    // The paths are read from sys.argv, not substituted into the script text: substituted, a
    // path would become Python code, a second level of interpretation after the shell. Under
    // fontforge -c, sys.argv is ["-c", ...the arguments after the script], and a path in it stays
    // a string. The same holds for convertToSvgScript.
    private readonly convertScript = "import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])";
    // Writing an SVG font, fontforge puts a glyph into one <glyph> element and leaves the other code
    // points of the glyph out (svg_sfdump of its svg.c). A glyph with a ligature of a liga or rlig
    // lookup whose components all have code points goes under the components alone, so an icon of an
    // icon font loses its code point to its name. A glyph with an Arabic presentation form among its
    // code points goes under the first such form alone. The script gives each code point left out a
    // copy of the glyph, a reference to it, which fontforge writes under that code point
    // (issue https://github.com/yuldashevsardor/telegram-bot/issues/917). isArabicForm repeats
    // isarabinitial and its siblings of fontforge, which are the decomposition tags of Unicode.
    private readonly convertToSvgScript = [
        "import fontforge, sys, unicodedata",
        "font = fontforge.open(sys.argv[1])",
        "def isArabicForm(codePoint):",
        '    tag = unicodedata.decomposition(chr(codePoint)).split(" ")[0]',
        '    return tag in ("<initial>", "<medial>", "<final>", "<isolated>")',
        "def isWrittenAsLigature(glyph):",
        '    for posSub in glyph.getPosSub("*"):',
        '        if posSub[1] != "Ligature":',
        "            continue",
        "        lookup = font.getLookupOfSubtable(posSub[0])",
        "        features = [feature[0] for feature in font.getLookupInfo(lookup)[2]]",
        "        components = posSub[2:]",
        '        isLigaOrRlig = "liga" in features or "rlig" in features',
        "        hasEncodedComponents = all(name in font and font[name].unicode != -1 for name in components)",
        "        if isLigaOrRlig and len(components) > 1 and hasEncodedComponents:",
        "            return True",
        "    return False",
        "copies = []",
        "for glyph in font.glyphs():",
        "    codePoints = []",
        "    for codePoint in [glyph.unicode] + [alt[0] for alt in (glyph.altuni or ()) if alt[1] == -1]:",
        "        if codePoint != -1 and codePoint not in codePoints:",
        "            codePoints.append(codePoint)",
        "    arabicForms = [codePoint for codePoint in codePoints if isArabicForm(codePoint)]",
        "    if isWrittenAsLigature(glyph):",
        "        leftOutCodePoints = codePoints",
        "    elif arabicForms:",
        "        leftOutCodePoints = [codePoint for codePoint in codePoints if codePoint != arabicForms[0]]",
        "    else:",
        "        leftOutCodePoints = []",
        "    for codePoint in leftOutCodePoints:",
        "        copies.append((glyph, codePoint))",
        "for glyph, codePoint in copies:",
        '    copy = font.createChar(-1, "%s.u%04X" % (glyph.glyphname, codePoint))',
        "    copy.addReference(glyph.glyphname)",
        "    copy.width = glyph.width",
        "    copy.vwidth = glyph.vwidth",
        "    copy.unicode = codePoint",
        "font.generate(sys.argv[2])",
    ].join("\n");

    public constructor(
        @inject<SvgFontPreparer>(Tokens.Font.Engine.SvgFontPreparer) private readonly svgFontPreparer: SvgFontPreparer,
        private readonly fontForgePath: string = configValue("fontForgePath"),
    ) {}

    public async convert(srcPath: string, distPath: string): Promise<void> {
        const srcExtension = (await FileHelper.getFileExtension(srcPath)).toLowerCase();
        const distExtension = await FileHelper.getFileExtension(distPath);

        if (!this.supportedExtensions.includes(srcExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(srcExtension);
        }

        if (!this.supportedExtensions.includes(distExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(distExtension);
        }

        const script = distExtension === Extension.SVG ? this.convertToSvgScript : this.convertScript;

        if (srcExtension !== Extension.SVG) {
            await this.run(script, distPath, { readPath: srcPath, sourcePath: srcPath });

            return;
        }

        // The engine misreads an SVG font that leaves the advance of a glyph to <font>, so it reads a
        // prepared copy (SvgFontPreparer). The result name is unique in its directory, so a name
        // derived from it is unique too.
        const preparedPath = `${distPath}.${Extension.SVG}`;

        await FileHelper.removeAfter(preparedPath, async () => {
            await this.svgFontPreparer.prepare(srcPath, preparedPath);
            await this.run(script, distPath, { readPath: preparedPath, sourcePath: srcPath });
        });
    }

    /**
     * `readPath` is the file the engine reads, `sourcePath` the font the conversion was given, which
     * the error names: for an SVG source they differ.
     */
    private async run(script: string, distPath: string, paths: { readPath: string; sourcePath: string }): Promise<void> {
        try {
            await ProcessHelper.run(this.fontForgePath, ["-c", script, paths.readPath, distPath]);
        } catch (error) {
            throw ExecuteError.bySource(paths.sourcePath, error);
        }
    }
}
