import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessHelper } from "app/shared/process/process-helper";
import { injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import { Extension } from "app/font-convertor/font-convertor.types";
import { configValue } from "app/shared/config-value";

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
    // fontforge writes a glyph into one SVG element and leaves some of its code points out. The script
    // gives each code point left out a copy of the glyph, which fontforge writes under that code point.
    // Which code points fontforge leaves out and which of its rules the script repeats:
    // docs/architecture/font-convertor.md, "Writing SVG".
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
        // createChar returns the glyph that already has the name, and the copy would overwrite it.
        "def freeCopyName(glyph, codePoint):",
        '    copyName = "%s.u%04X" % (glyph.glyphname, codePoint)',
        "    while copyName in font:",
        '        copyName += "_"',
        "    return copyName",
        // The copies are made after the walk over font.glyphs(): the walk then does not depend on how
        // the iterator of fontforge treats glyphs added to the font under it.
        "pendingCopies = []",
        "for glyph in font.glyphs():",
        "    altCodePoints = [alt[0] for alt in (glyph.altuni or ()) if alt[1] == -1]",
        "    codePoints = []",
        "    for codePoint in [glyph.unicode] + altCodePoints:",
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
        "        pendingCopies.append((glyph, codePoint))",
        "for glyph, codePoint in pendingCopies:",
        "    copy = font.createChar(-1, freeCopyName(glyph, codePoint))",
        "    copy.addReference(glyph.glyphname)",
        "    copy.width = glyph.width",
        "    copy.vwidth = glyph.vwidth",
        "    copy.unicode = codePoint",
        "font.generate(sys.argv[2])",
    ].join("\n");

    public constructor(private readonly fontForgePath: string = configValue("fontForgePath")) {}

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

        try {
            await ProcessHelper.run(this.fontForgePath, ["-c", script, srcPath, distPath]);
        } catch (error) {
            throw ExecuteError.byError(error);
        }
    }
}
