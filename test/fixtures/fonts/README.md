# Font fixtures

The same Roboto-Black in six formats. They are the input for manual conversion runs, for
`/font_generator` and for the specs. The specs need real fonts: signatures need real headers, not
invented ones, and the pairs convert real fonts. Which specs take the fixtures —
`grep -rl fixtures test --include='*.spec.ts'`.

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
the headers. So a replacement is checked by the format signature, not by a hash, and by a
`make test` run. `font-forge-convertor.spec.ts` converts every fixture except EOT with the real
fontforge into every other format except EOT. So a replacement the engine cannot open fails the
spec even with a correct signature.

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

The format of each file is checked by its signature. The `FontSignatureMatcher` spec rests on
that too, so a replacement is best checked by the same signs:

| file | sign |
|---|---|
| `test-font.ttf` | `00 01 00 00` |
| `test-font.otf` | `OTTO` |
| `test-font.woff` | `wOFF` |
| `test-font.woff2` | `wOF2` |
| `test-font.eot` | `0x504C` at offset 34, `EOTSize` in the first four bytes equals the file size |
| `test-font.svg` | `<?xml` — the XML declaration; the signature also accepts other markup, see `docs/architecture/font-convertor.md` |
