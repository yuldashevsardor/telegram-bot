import { FileHelper } from "app/shared/fs/file-helper";
import { ProcessHelper } from "app/shared/process/process-helper";
import { inject, injectable } from "inversify";
import { ExecuteError, ExtensionNotSupport } from "app/font-convertor/font-forge/font-forge.errors";
import type { ConvertOptions } from "app/font-convertor/font-forge/font-forge.types";
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
    // a string. sys.argv[1] is the font to read, sys.argv[2] the font to write, and for an SVG source
    // sys.argv[3] is the file of its unencoded glyph indexes from SvgFontPreparer, one a line, whose
    // code points the script takes off (docs/architecture/font-convertor.md, "Reading SVG"). The file
    // is opened with io.open: under fontforge -c the bare open is fontforge.open, which reads a font.
    private readonly openFontAndUnencodeGlyphsScript = [
        "import fontforge, io, sys",
        "font = fontforge.open(sys.argv[1])",
        "if len(sys.argv) > 3:",
        "    with io.open(sys.argv[3]) as unencodedGlyphsFile:",
        "        unencodedGlyphIndexes = {int(line) for line in unencodedGlyphsFile}",
        "    for glyph in font.glyphs():",
        "        if glyph.originalgid in unencodedGlyphIndexes:",
        "            glyph.unicode = -1",
    ];
    private readonly convertScript = [...this.openFontAndUnencodeGlyphsScript, "font.generate(sys.argv[2])"].join("\n");
    // fontforge writes a glyph into one SVG element and leaves some of its code points out. The script
    // gives each code point left out a copy of the glyph, which fontforge writes under that code point.
    // Which code points fontforge leaves out and which of its rules the script repeats:
    // docs/architecture/font-convertor.md, "Writing SVG".
    private readonly convertToSvgScript = [
        ...this.openFontAndUnencodeGlyphsScript,
        "import unicodedata",
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

    public constructor(
        @inject<SvgFontPreparer>(Tokens.Font.Engine.SvgFontPreparer) private readonly svgFontPreparer: SvgFontPreparer,
        private readonly fontForgePath: string = configValue("fontForgePath"),
    ) {}

    /**
     * `options.sourcePath` is the font the conversion was given, which an error of the engine names.
     * It is `inputPath` unless `inputPath` is a file made from the source, the unpacked sfnt of an EOT,
     * which is removed by the time the error is logged.
     */
    public async convert(inputPath: string, distPath: string, options: ConvertOptions = {}): Promise<void> {
        const sourcePath = options.sourcePath ?? inputPath;
        const inputExtension = (await FileHelper.getFileExtension(inputPath)).toLowerCase();
        const distExtension = await FileHelper.getFileExtension(distPath);

        if (!this.supportedExtensions.includes(inputExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(inputExtension);
        }

        if (!this.supportedExtensions.includes(distExtension as Extension)) {
            throw ExtensionNotSupport.byExtension(distExtension);
        }

        const script = distExtension === Extension.SVG ? this.convertToSvgScript : this.convertScript;

        if (inputExtension !== Extension.SVG) {
            await this.run(script, [inputPath, distPath], sourcePath);

            return;
        }

        // The engine misreads an SVG font that leaves the advance of a glyph to <font> and encodes
        // glyphs SVG 1.1 leaves unencoded, so it reads a prepared copy and the list of those glyphs
        // (SvgFontPreparer; why a file: docs/architecture/font-convertor.md, "Reading SVG"). The result
        // name is unique in its directory, so names derived from it are unique too.
        const preparedPath = `${distPath}.${Extension.SVG}`;
        const unencodedGlyphsPath = `${distPath}.unencoded`;

        await FileHelper.removeAfter(preparedPath, () =>
            FileHelper.removeAfter(unencodedGlyphsPath, async () => {
                const unencodedGlyphIndexes = await this.svgFontPreparer.prepare(inputPath, preparedPath);

                await FileHelper.write(unencodedGlyphsPath, new TextEncoder().encode(unencodedGlyphIndexes.join("\n")));
                await this.run(script, [preparedPath, distPath, unencodedGlyphsPath], sourcePath);
            }),
        );
    }

    /**
     * `scriptArgs` are what the script reads from sys.argv, `sourcePath` the font the conversion was
     * given, which the error names. The engine reads another file for an SVG source, its prepared
     * copy, and on a route from EOT, its unpacked sfnt.
     */
    private async run(script: string, scriptArgs: Array<string>, sourcePath: string): Promise<void> {
        try {
            await ProcessHelper.run(this.fontForgePath, ["-c", script, ...scriptArgs]);
        } catch (error) {
            throw ExecuteError.bySource(sourcePath, error);
        }
    }
}
