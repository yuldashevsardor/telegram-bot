# Font fixtures

The same Roboto-Black in six formats, EOT twice: with a raw and with a compressed font. They are
the input for manual conversion runs, for `/font_generator` and for the specs. The specs need real
fonts: the validators need real headers, not invented ones, and the pairs convert real fonts. Which
specs take the fixtures — `grep -rl fixtures test --include='*.spec.ts'`.

The directory lives in `test/`, not in `tmp/` as it used to. Files from `tmp/` never reached the
container at all: `tmp` is listed in `.dockerignore`, and on top of that the `app-tmp` volume
covers it.

The base format is `test-font.ttf`, and the rest is made from it. `test-font.ttf`,
`test-font.otf`, `test-font.woff` and `test-font.svg` were moved here from `tmp/app/test-fonts`
byte for byte, as fontforge made them in 2022. Only `test-font.woff2` and `test-font.eot` were
made anew: these two turned out not to be in their own format.

WOFF2 is made in the application image with the regular conversion script
(`FontForge.convertScript`). So are OTF, WOFF and SVG, should a replacement be needed:

```sh
fontforge -c 'import fontforge, sys; font = fontforge.open(sys.argv[1]); font.generate(sys.argv[2])' \
    test-font.ttf test-font.<otf|woff|woff2|svg>
```

A re-run will not give the bytes that lie here: fontforge writes its version and build date into
the headers. So a replacement is checked by the signs of its format below, not by a hash, and by a
`make test` run. `font-forge-convertor.spec.ts` converts every fixture except EOT with the real
fontforge into every other format except EOT, the EOT fixture into SVG, and sources made from the
SVG fixture into every other format, EOT included. So a replacement the engine cannot open fails
the spec even when its validator accepts it.

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
