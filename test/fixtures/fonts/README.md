# Font fixtures

At the root, the same Roboto-Black in six formats, EOT twice: with a raw and with a compressed
font. They are the input for manual conversion runs, for `/font_generator` and for the specs. The
specs need real fonts: the validators need real headers, not invented ones, and the pairs convert
real fonts. Which specs take the fixtures — `grep -rl fixtures test --include='*.spec.ts'`.

In the directories, a font each, the corpus of real fonts ("The corpus" below). Of the specs only
`font-forge.spec.ts` takes some of its fonts, for the ligatures and Arabic forms Roboto does not
have.

The conversion check of `make test-fonts` (`test/conversion/conversion.check.ts`) takes every font
of both: it converts each into every format the pair table takes it to and compares the facts of
the font before and after (`docs/architecture/testing.md`, "The conversion check").

The directory lives in `test/`, not in `tmp/` as it used to. Files from `tmp/` never reached the
container at all: `tmp` is listed in `.dockerignore`, and on top of that the `app-tmp` volume
covers it.

The base format is `test-font.ttf`, and the rest is made from it. `test-font.ttf`,
`test-font.otf`, `test-font.woff` and `test-font.svg` were moved here from `tmp/app/test-fonts`
byte for byte, as fontforge made them in 2022. Only `test-font.woff2` and `test-font.eot` were
made anew: these two turned out not to be in their own format.

WOFF2 is made in the application image with the command below, and so are OTF, WOFF and SVG, should
a replacement be needed. The command does what the regular conversion script
`FontForge.convertScript` does for a source that is not SVG: the part of that script that takes code
points off runs only for an SVG source, given the list of its unencoded glyphs as a third argument.
The bot writes SVG with `FontForge.convertToSvgScript`, which copies some glyphs first; measured
with fontforge 20230101, it writes the same 1296 glyphs from `test-font.ttf` as the command below,
since the font has no glyph it copies:

```sh
fontforge -c 'import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])' \
    test-font.ttf test-font.<otf|woff|woff2|svg>
```

A re-run will not give the bytes that lie here: fontforge writes its version and build date into
the headers. So a replacement is checked by the signs of its format below, not by a hash, and by a
`make test` run. `font-forge-convertor.spec.ts` converts every fixture except EOT with the real
fontforge into every other format except EOT, the EOT fixture into SVG, the compressed EOT fixture
into WOFF, and sources made from the SVG fixture into every other format, EOT included. So a
replacement the engine cannot open fails the spec even when its validator accepts it. A replacement
whose facts convert differently fails `make test-fonts`: its list of expected differences was
measured on the fixtures that lie here.

`test-font.eot` cannot be made with this command. fontforge does not know the `.eot` extension
and silently writes PostScript Type 1 instead of EOT. That is exactly how two fixtures of the
wrong format got into the repository (issue
[#153](https://github.com/yuldashevsardor/telegram-bot/issues/153)). The EOT was made by a
third-party tool that is not in the image:

```sh
npx ttf2eot test-font.ttf test-font.eot
```

fontforge cannot open a finished EOT either, so the domain puts the EOT envelope on and takes it
off itself (`EotPacker`, issue [#158](https://github.com/yuldashevsardor/telegram-bot/issues/158)).
That makes the origin of `test-font.eot` doubly important. `EotPacker` has to build these bytes
from `test-font.ttf`, all but `fsType` (`docs/architecture/font-convertor.md`, "Known"). The
byte-for-byte test is the only check in the repository of the envelope against the format rather
than against itself. Do not rebuild this file with our own code: the check would become a
tautology.

`test-font-compressed.eot` holds the same font compressed with MicroType Express
(`TTEMBED_TTCOMPRESSED`), the way a third of real EOT files are. It is made from `test-font.ttf` by
`SfntTool` of sfntly (Google, Apache-2.0, `googlefonts/sfntly`), another tool that is not in the
image. The `java/` directory of that repository is built with `ant`, and the command runs from it:

```sh
java -cp "build/classes:lib/*" com.google.typography.font.tools.sfnttool.SfntTool -e -x test-font.ttf test-font-compressed.eot
```

A re-run gives the same bytes: 50 334 of them, version `0x00020002`, flags `0x00000004`. The
decoded sfnt differs from `test-font.ttf` in bytes, since MicroType Express rebuilds `glyf`, `loca`
and `head`. So `eot-packer.spec.ts` compares the glyphs point by point, not a hash. The domain does
not compress, so this file, like `test-font.eot`, cannot be rebuilt with our own code.

Every format is checked by its validator: the sign of each file is that its validator accepts it.

| file | sign |
|---|---|
| `test-font.ttf` | `SfntFontValidator` accepts it, version `00 01 00 00`, see `docs/architecture/font-convertor.md`, "The sfnt validator" |
| `test-font.otf` | `SfntFontValidator` accepts it, version `OTTO`, see `docs/architecture/font-convertor.md`, "The sfnt validator" |
| `test-font.woff` | `WoffFontValidator` accepts it, see `docs/architecture/font-convertor.md`, "The WOFF validator" |
| `test-font.woff2` | `Woff2FontValidator` accepts it, see `docs/architecture/font-convertor.md`, "The WOFF2 validator" |
| `test-font.eot` | `EotFontValidator` accepts it, see `docs/architecture/font-convertor.md`, "The EOT validator" |
| `test-font-compressed.eot` | `EotFontValidator` accepts it, flags `0x00000004` at offset 12 |
| `test-font.svg` | `SvgFontValidator` accepts it, see `docs/architecture/font-convertor.md`, "The SVG validator" |

## The corpus

Roboto was written by fontforge in every format, so on it the engine mostly reads its own output,
and its OTF is a TrueType font regenerated with CFF outlines. The corpus adds fonts written by other
tools or by a fontforge eleven years older than the image's, and fonts of other kinds. Each lies in
a directory of its own with its licence: all are under the SIL Open Font License 1.1, which requires
the licence to go with the font. The files are not downloaded during the run: the check must not
depend on the network.

| file | where from | version | SHA-256 | case |
|---|---|---|---|---|
| `font-awesome/fontawesome-webfont.ttf` | [FortAwesome/Font-Awesome](https://github.com/FortAwesome/Font-Awesome/tree/v4.7.0/fonts), tag `v4.7.0` | 4.7.0 | `aa58f33f239a0fb02f5c7a6c45c043d7a9ac9a093335806694ecd6d4edc0d6a8` | icons in the Private Use Area, units-per-em 1792; written by FontForge 20120731 (`FFTM`) |
| `font-awesome/fontawesome-webfont.woff` | the same | 4.7.0 | `ba0c59deb5450f5cb41b3f93609ee2d0d995415877ddfa223e8a8a7533474f07` | a WOFF written by FontForge 20120731, not by the engine of the image |
| `font-awesome/fontawesome-webfont.woff2` | the same | 4.7.0 | `2adefcbc041e7d18fcf2d417879dc5a09997aa64d675b7a3c4b6ce33da13f3fe` | a WOFF2 made outside the repository |
| `font-awesome/fontawesome-webfont.eot` | the same | 4.7.0 | `7bfcab6db99d5cfbf1705ca0536ddc78585432cc5fa41bbd7ad0f009033b2979` | an EOT made outside the repository, version `0x00020001` |
| `font-awesome/fontawesome-webfont.svg` | the same | 4.7.0 | `ad6157926c1622ba4e1d03d478f1541368524bfc46f51e42fe0d945f7ef323e4` | an SVG font written by FontForge 20120731 (its `<metadata>`), not by the engine of the image |
| `font-awesome/FontAwesome.otf` | the same | 001.001 | `444dd4366615ffc4a16d012b2fa90137065d3ccb410fa6fd5e4ddd7b5e4ffcd5` | CFF outlines written without fontforge (no `FFTM`), without `.null` and `nonmarkingreturn` |
| `source-sans-3/SourceSans3-Regular.otf` | [adobe-fonts/source-sans](https://github.com/adobe-fonts/source-sans/releases/tag/3.052R), release `3.052R`, `OTF/` of `OTF-source-sans-3.052R.zip` | 3.48 | `08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6` | a font designed with CFF outlines; combining marks of zero width |
| `noto-naskh-arabic/NotoNaskhArabic-Regular.ttf` | [notofonts/arabic](https://github.com/notofonts/arabic/releases/tag/NotoNaskhArabic-v2.021), release `NotoNaskhArabic-v2.021`, `NotoNaskhArabic/unhinted/ttf/` of the zip | 2.021 | `c34fdbd98af4dbc45ca192a23d2eeb77032add83086f5fe32957d23b3f36b221` | a complex script with `GSUB` and `GPOS`, Arabic forms |
| `bungee-spice/BungeeSpice-Regular.ttf` | [google/fonts](https://github.com/google/fonts/tree/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/bungeespice), commit `2eb0b48d` | 2.000 | `ccf8e3f7eb1ac87ed217097332856f9007484362a00ae3b42a03c6ef851158d0` | a colour font: `COLR`, `CPAL` and `SVG ` |
| `pacifico/Pacifico-latin.woff2` | Google Fonts, `https://fonts.gstatic.com/s/pacifico/v23/FwZY7-Qmy14u9lezJ-6H6MmBp0u-.woff2` | 3.001 | `1a47a54e53bbfd3cfb4673636eac5edc98a7ecbf36c41340f48086a4f4796b18` | a WOFF2 of Google's encoder, a subset that keeps glyphs it does not encode |
| `inter/Inter[opsz,wght].ttf` | [google/fonts](https://github.com/google/fonts/tree/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/inter), commit `2eb0b48d` | 4.001 | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` | a variable font, axes `opsz` and `wght` |

Font Awesome 4.7 ships no licence file: its `README.md` names the SIL OFL 1.1 for the font, and
`font-awesome/OFL.txt` is the licence text with the copyright of the font's `name` table. The
others carry the licence file of their source: `OFL.txt` of the directory in google/fonts, of the
Noto zip, and `LICENSE.md` of the Source Sans repository at the tag, kept as `LICENSE.txt`: the
width check of `make check` takes every `*.md` as prose. Pacifico's licence comes from
`ofl/pacifico/OFL.txt` of google/fonts at the same commit as Bungee Spice and Inter.

The Pacifico file is the `latin` subset of what the CSS API serves to a current Chrome:
`https://fonts.googleapis.com/css2?family=Pacifico` lists one WOFF2 per subset, and only for a
browser it knows to read WOFF2. Noto Naskh Arabic is the unhinted build: hinting is not among the
facts of the check, and the file is 159 KB against 247 KB of the hinted one.

What fontforge does to the variable font the check does not see either. It keeps the default
instance, Inter Regular (`wght` 400, `opsz` 14), and drops `fvar`, `gvar`, `avar`, `HVAR`, `MVAR`
and `STAT`: the axes are not among the facts, and the default outlines are the font's own. The
check does see that the bot converts it at all, past the volume of warnings fontforge prints on it
(`docs/architecture/font-convertor.md`, "Running the engine").

What fontforge does to the colour font the check does not see: `COLR`, `CPAL` and `SVG ` are not
among its facts. fontforge ignores the three tables on reading, and the result keeps the
one-colour outlines of the base glyphs.
