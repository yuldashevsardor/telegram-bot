# Font conversion

```
FontConvertor.convert({ originPath, extension })
  → source extension ≠ target one, otherwise FontConvertorError
  → name: 15 random characters + extension, directory tempDir/YYYY/M/D
    (FileHelper.createDirectoriesByDate(): tempDir exists, is readable, is writable and is a
    directory)
  → ConvertorFactory.get(from, to): from the pair table, one class per pair,
    convertor/<from>/<from>-to-<to>.ts
  → Convertor.validate(): the source exists and is readable, its extension matches, the validator
    of its format accepts it (FontValidatorResolver); the result path does not exist
  → FontForge.convert(): fontforge -c '<script>' SRC DIST through ProcessHelper.run; an SVG
    source is handed over as a prepared copy, SRC, and the list of its unencoded glyphs, a third
    argument (SvgFontPreparer, "Reading SVG")
```

## EOT

The EOT format bypasses the engine as a whole, not pair by pair. `FontForge.supportedExtensions` has
no `Extension.EOT`, and no `.eot` file is ever a `fontforge` argument. The engine does not read the
EOT envelope and silently corrupts the file on writing ([invariant](./invariants.md)). `EotPacker`
takes the envelope off and puts it on. So when an EOT pair needs the engine, the engine reads or
writes a plain sfnt, never the envelope:

```
ttf → eot                    EotPacker.pack(SRC, DIST)
{otf,woff,woff2,svg} → eot   FontForge.convert(SRC, DIST.ttf) → EotPacker.pack(DIST.ttf, DIST)
eot → ttf                    EotPacker.unpack(SRC, DIST)
eot → {otf,woff,woff2,svg}   EotPacker.unpack(SRC, DIST.ttf) → FontForge.convert(DIST.ttf, DIST)
```

The intermediate sfnt lies next to the result as `<result>.ttf`. The result name is unique in its
directory, so the derived name is unique too. The intermediate file is removed after a success and
after a failure alike, but not in `finally`. There `RemoveFailed` would displace the original error,
and the real reason for the failure would not survive even in `cause`. So precedence is the opposite
of `finally`'s: a removal error surfaces only if nothing failed before it
(`FileHelper.removeAfter()`).

The `Convertor` classes of the EOT pairs inherit from two parents. They are kept apart so that no
pair class gets what it does not need:

- `EotConvertor` is the constructor for the pairs the codec alone is enough for (`ttf ↔ eot`).
  `TtfToEot` and `EotToTtf` declare both extensions and keep `convert()` to themselves: in
  `EotConvertor` there is nowhere for the body to move up to.
- `TwoStepEotConvertor` is the constructor and the intermediate path for the other eight pairs.
  Their bodies live in `ToEotConvertor` and `FromEotConvertor`. The eight classes are empty except
  for declaring the missing extension.

`EotPacker` (`eot-packer/`) is one of the seven places on the conversion path where the domain
parses the content of a font; the others are the SVG, WOFF, WOFF2, EOT and sfnt validators below
and `SvgFontPreparer` ("Reading SVG"). Two of them, the codec and the EOT validator, also hand a
compressed `FontData` to `mtx-decompressor` through `EotPayloadDecoder` (below), which parses it.
The EOT header duplicates the metadata of the enclosed font. `SfntReader` takes it from the `OS/2`,
`head` and `name` tables. The envelope holds four names, in UTF-16LE. The slant is taken from
`OS/2.fsSelection`, not from `head.macStyle`, which duplicates it. `ttf2eot` does the same. Besides,
in `macStyle` the slant is bit 1, and bit 1 of `fsSelection` means something else.

Names are read from the Windows platform, failing that from Unicode, then from Macintosh. On
Macintosh only `encodingId 0` is read: only that one is single-byte MacRoman, the other records hold
national encodings. Within a platform English is preferred (`0x0409` on Windows, `0` on the others),
because a font does not guarantee the order of its records.

The names are informational, so the codec never rejects a font over a missing name: the matching
envelope field stays empty. That holds for a missing record, a missing `name` table, and a string
past the declared end of the table or past the end of the file. A TTF source without the `name`
table, or with a non-empty string past its end, does not reach the codec: `SfntFontValidator`
below rejects it. So the tolerance for a missing table and for a non-empty string out of bounds
serves the intermediate sfnt the engine writes, while a missing record or an empty string out of
bounds is packed from a source too.

`eot-packer.ts` writes version `0x00020001`. The header is read through `EotHeader`
(`font-convertor/eot-header/`), which lays out the fixed part, the names and the tail of every
version, and where the font lies. It rejects only what leaves it nothing to read, an empty
`FontDataSize` included, and exposes the rest: the codec itself checks the magic number, `EOTSize`
and that the names end before the font. `EotHeader` lies outside `eot-packer/` because the codec is
not its only reader: `EotFontValidator` below reads it too, and a second parse of the same header
would be a second copy of one format rule.

`FontData` is not always the raw sfnt. Under `TTEMBED_TTCOMPRESSED` it is compressed by W3C Member
Submission "MicroType Express (MTX) Font Format" (2008), under `TTEMBED_XORENCRYPTDATA` each byte is
XOR `0x50` (EOT, §4.4), and both flags may be set at once. `EotPacker.unpack()` hands `FontData`
with the `Flags` of the header to `EotPayloadDecoder` (`font-convertor/eot-payload-decoder/`), which
returns the sfnt, or `FontData` itself when neither flag is set. A failure of the decoding is
`InvalidEotPayload`, with the error of the decoder as its cause. The decoder lies outside
`eot-packer/` for the same reason as `EotHeader`: the validator decodes with it too. The domain
writes only the raw sfnt: `EotPacker.pack()` sets no flag.

The decoding is `decompressMtx()` of the npm package `mtx-decompressor`, a TypeScript port of
libeot under MPL-2.0. The package sees only `FontData`: the envelope stays with `EotHeader`. MPL is
copyleft per file, so using the package unchanged asks nothing of an MIT project. The version is
pinned exactly, `1.8.0`, not by a caret range like the rest of `package.json`: the project is from
2026-03, with one maintainer and 37 versions in six months. An update is a decision of its own,
with the acceptance run of [#743](https://github.com/yuldashevsardor/telegram-bot/issues/743)
repeated: the 367 real EOT files of #617, none rejected, the 120 compressed ones passing the sfnt
validator. Two other ways were rejected
([#741](https://github.com/yuldashevsardor/telegram-bot/issues/741)). libeot `eot2ttf` 0.01 of
Debian loses `glyf` bytes on 12 real files, gets the instructions of 1470 glyphs wrong and is killed
by a signal on 593 of 600 damaged inputs. A decoder of our own is about 2950 lines.

## Running the engine

The engine is launched only through `ProcessHelper.run(file, args)`, a wrapper over
`child_process.spawn` ([invariant](./invariants.md)). The arguments go as an array, past
`/bin/sh`. Building the command as a string and calling `exec` is not allowed here, because the file
name comes from the user. The same technique removes the second level of interpretation, Python's:
the script reads the paths passed as arguments from `sys.argv`, they are not substituted into the
script text.

Of stderr the wrapper keeps only the end, `STDERR_TAIL_BYTES`, and stdout whole. fontforge prints a
warning for every glyph it does not like, and the volume follows the font: on the variable Inter of
the corpus it prints 2.4 MB and exits with 0. `execFile` keeps the whole output and rejects past its
`maxBuffer`, 1 MiB by default, so under it the bot failed such a font in every format, throwing away
the written result ([#912](https://github.com/yuldashevsardor/telegram-bot/issues/912)). The tail
is what goes into the message of `ProcessFailed`, so the error stays bounded too.

## Reading SVG

fontforge 20230101 misreads an SVG font that leaves the advance of a glyph to `<font>`, as SVG 1.1
allows: a `glyph` or `missing-glyph` without `horiz-adv-x` takes the `horiz-adv-x` of `<font>`
(§20.4, §20.5). fontforge takes a non-zero advance of `<font>` and reads `0` as none, giving such a
glyph the em, and it drops a glyph that has neither `horiz-adv-x` nor `d`. An empty glyph with
`horiz-adv-x="0"` is kept. fontforge writes such fonts itself: it leaves out every advance equal to
the one it puts on `<font>`, 0 in Source Sans 3 and 1000 in Bungee Spice. Measured for
[#913](https://github.com/yuldashevsardor/telegram-bot/issues/913): read back, the combining marks
of Source Sans 3 were 1000 wide instead of 0, and its U+200B and U+FEFF were gone.

fontforge also misreads a glyph with `arabic-form`. SVG 1.1 has it as a form of the letter its
`unicode` names (§20.5). fontforge reads a glyph of one code point from U+0600 to U+06FF under the
code point its table gives for that letter and form (`SVGParseGlyphArgs` of `svg.c`,
`Unicode/ArabicForms.c`): `<glyph unicode="&#x627;" arabic-form="isolated">` becomes U+FE8D, and a
font whose letters have only glyphs with `arabic-form` comes out with none of the letters a text is
typed with. fontforge knows the forms `initial`, `medial`, `final` and `isolated`, while SVG 1.1
spells the end form `terminal`; a glyph with a value it does not know it reads under the letter, as
one without the attribute. The table finds a form by its Unicode name, "<letter> INITIAL FORM" and
so on (`makeutype.py`). The initial and medial forms of U+0649, U+FBE8 and U+FBE9, are named after
the languages that use them, so the table gives U+0649 itself for them; by the Unicode 14 data of
the image no other form is missing from it.

So the engine never reads an SVG source itself. `FontForge.convert()` has `SvgFontPreparer`
(`svg-preparer/`) write a copy next to the result, `<result>.svg` (`<result>.ttf.svg` on the
way to EOT), hands the engine the copy and removes it as the intermediate sfnt of EOT is removed.
The copy differs from the source in four edits, and the last three touch `glyph` alone: fontforge
reads `missing-glyph` as .notdef, whatever its `unicode` and `arabic-form` say.

- the advance of `<font>` is written on every `glyph` and `missing-glyph` that leaves it out;
- `arabic-form="terminal"` is written as `"final"`;
- `arabic-form="isolated"` is taken off a glyph of one code point unless another `glyph` of the
  source with the same `unicode` is one fontforge reads under the letter: one without a form, one
  whose `arabic-form` is none of the four SVG 1.1 values, nor `final`, or an initial or medial
  glyph of U+0649 the next edit leaves in place. Without the attribute fontforge reads the glyph
  under the letter;
- a glyph of U+0649 with `arabic-form="initial"` or `"medial"` is written as
  `unicode="&#xFBE8;"` or `"&#xFBE9;"` without `arabic-form`, unless a glyph already has that
  code point, one the copy writes there for a glyph earlier in the file included.

The isolated glyph goes under its letter alone, and its presentation form is left without a glyph:
fontforge reads one element as one glyph of one code point, so keeping both would take a second
element, and a text is typed with the letters, while Unicode keeps the presentation forms for
compatibility. A font converted into SVG and back that has the isolated presentation form but no
glyph of its letter comes back with the letter in place of the form. A letter that has a glyph
without a form keeps it, and its isolated glyph stays where fontforge reads it: under the
presentation form, or under the letter too when the table of fontforge has no isolated form of it.
This is how a font written into SVG comes back ("Writing SVG"). The initial, medial and final forms
stay where fontforge reads them too: under the letter they would take its place. A glyph without
`unicode` does not count as a glyph of the letter, even when its name spells the letter: SVG 1.1
maps it to no code point, and the bot keeps it unencoded (below). The copy takes the isolated form
off, and the presentation form is left without a glyph.

Nothing else of the file changes but a UTF-8 BOM, which XML does not need: the advance goes before
the end of the start tag, a removed or rewritten attribute takes the whitespace before it along but
for the character that ends the tag name, the copy is written in the encoding of the source
(`SvgTextCodec`, which `SvgFontValidator` reads the file with too), and it takes the modification
time of the source, since fontforge stamps the font it writes with the time of the file it reads.
The preparer leans on the rules of the validator, which the source has passed: one `font` with
`horiz-adv-x`, the font nodes in the SVG namespace and without prefixed attributes. So it matches
the elements by their local names, without the namespace bindings the validator makes. A failure
of the engine names the source in `path` of its `ExecuteError`: the copy the process read is
gone by the time the error is logged.

fontforge also encodes the glyph elements SVG 1.1 maps to no code point: every `missing-glyph`, and
a `glyph` whose `unicode` is not one character, absent, empty or a ligature of several (§20.4,
§20.5). It gives a `missing-glyph` U+0000, a ligature the code point it finds for its characters
(`unicode="fi"` U+FB01, whatever the glyph is called), and any other such `glyph` the code point
its `glyph-name` spells (`Ldot` U+013F, `uni0041` U+0041 beside the glyph of `A`,
`nonmarkingreturn` U+000D). Measured for
[#925](https://github.com/yuldashevsardor/telegram-bot/issues/925): Font Awesome, Source Sans 3 and
Pacifico converted to SVG and read back gained such code points. The text of the file cannot say
"no code point" to fontforge, so `SvgFontPreparer.prepare()` answers with the indexes of those
glyphs, counting the `glyph` and `missing-glyph` children of `<font>` in document order, and
`FontForge.convert()` writes them into a second file next to the result, `<result>.unencoded`
(`<result>.ttf.unencoded` on the way to EOT), removed with the copy. The script takes the code
point off each glyph whose `originalgid` is in the list: fontforge numbers the glyph elements in the
same order and counts the ones it drops too, so an index finds the glyph under any name fontforge
gives it, `glyph4` for a glyph without `glyph-name` or `uni0066_uni0074` for an unnamed
`unicode="ft"`. The list goes in a file and not as arguments of the process: `ProcessFailed` quotes
the arguments in its message, and a font has as many unencoded glyphs as it likes. A glyph fontforge
writes without `unicode` because XML 1.0 has no such character, `uni0002` of U+0002, so stays
unencoded on the way back, as SVG 1.1 reads it.

## Writing SVG

A pair into SVG runs `FontForge.convertToSvgScript` instead of `convertScript`. fontforge 20230101
writes a glyph into one `<glyph>` element and leaves its other code points out (`svg_sfdump` of its
`svg.c`):

- a glyph with a ligature of a `liga` or `rlig` lookup, whose components all have code points,
  goes under the components alone. An icon font with ligatures loses every code point this way:
  from Material Icons fontforge writes none of the 2229 glyphs under its code point, only under its
  name (`unicode="warning"`);
- a glyph with an Arabic presentation form among its code points goes under the first such form
  alone, as the base letter with `arabic-form`. Its other code points, the base letter of the
  isolated form among them, are left out.

Before writing, the script adds a copy of such a glyph, a reference to it named
`<glyph name>.u<code point>`, for each code point left out, and fontforge writes the copy under that
code point ([#917](https://github.com/yuldashevsardor/telegram-bot/issues/917)). A name another
glyph already has gets `_` appended until it is free: fontforge's `createChar` returns the glyph
that has the name, and the copy would overwrite it and its code point. The original keeps
its element: the ligature and the Arabic form stay. A copy has no kerning pairs of its own. The
script repeats the rules of fontforge: which lookups count as `liga` and which code points are
presentation forms (the decomposition tags `<initial>`, `<medial>`, `<final>` and `<isolated>` of
Unicode). A new fontforge that changes them shows in `make test-fonts` on the fixtures only.

A presentation form that is the only code point of its glyph is written as SVG 1.1 has it, the base
letter with `arabic-form`, and gets no copy. fontforge reads such an element back under the form
its table gives for the base letter in that position, but where the prepared copy changes it
("Reading SVG"): U+FBE8 and U+FBE9, which its table lacks, come back under their own code points,
and an isolated form whose letter has no glyph comes back under the letter.

A ligature glyph whose code point is a presentation form of two letters, such as a lam-alef U+FEFB
that a `liga` or `rlig` lookup makes of U+0644 and U+0627, does get a copy. fontforge writes the
ligature as `unicode="&#x644;&#x627;"` with `arabic-form="isolated"`, and the copy as
`unicode="&#xfefb;"`: it replaces a form with its base letter only when the decomposition is one
letter (`svg_scdump`). Reading the ligature element back, fontforge gives it U+FEFB only by the
glyph name `uniFEFB` (`SVGParseGlyphArgs`), and the bot takes that code point off ("Reading SVG"),
so the copy is the only element that carries the code point. Measured on
`NotoNaskhArabic-Regular.ttf` with a `liga` ligature added to `uniFEFB`: no font among the fixtures
has such a glyph.

## Signatures

The source format is checked twice: by the extension of the name and by the content. The content is
checked by a `FontValidator` (`validator/`), each of which knows one format and reads the whole
file. `FontValidatorResolver`, a singleton in the container, holds one validator per format and
gives a pair the one of its source format, so a pair holds the resolver and none of the checks. The
validators come from the container. No format is checked by its signature alone. SVG has none: its
first bytes could say at most "this is markup", not "this is a font", so `SvgFontValidator` below
reads the whole document. WOFF has one, `wOFF`, WOFF2 has `wOF2`, EOT has `MagicNumber` at offset
34, and TTF and OTF have the sfnt version, but each is only the first rule of its container:
`WoffFontValidator`, `Woff2FontValidator`, `EotFontValidator` and `SfntFontValidator` below check it
together with the rest. The name is set by whoever sent the file, so the extension alone cannot be
trusted. The code recognises the formats itself, without an external tool.
`file --mime-type` gives no usable answer for three of the five binary formats: none at all for EOT,
and for TTF and OTF the answer also depends on the libmagic version.

The content does not tell TTF from OTF. Both use the sfnt container, and the sfnt version names
the outline type, not the extension. Outlines of either type are legal under both names. So both
extensions take the same validator: it confirms the container, and the extension still picks the
conversion pair.

The accepted versions leave out one: the `ttcf` collection. A collection holds several fonts, and
which of them to take is not the domain's call. The engine would silently take the first, while the
EOT envelope would reject the whole file, so one and the same file would behave differently from
pair to pair. A collection named `.ttf` or `.otf` is therefore rejected on input, the same way for
every pair, before the chosen pair does any work.

This does not make the version check of the codec redundant. The sfnt validator sees only the
sources: a TTF or OTF file and the sfnt a WOFF or an EOT carries. One more file passes through the
codec that the validator never saw: the intermediate sfnt from the engine on packing. The codec
checks less than the validator: the header size, the version and the bounds of the tables it
reads, not the rules below. But the two share one set of versions with two more checks,
`SFNT_VERSIONS` in `font-convertor/sfnt-version.ts`: `WoffFontValidator` (`validator/woff/`) checks
the flavor of a WOFF against it, and `Woff2FontValidator` (`validator/woff2/`) the flavor of a
WOFF2. The flavor is the version of the sfnt the container carries. The set must not become several
lists, because a divergence breaks behaviour rather than the build. A version known only to the
validator still fails on input: the directory the validator builds rejects it, with the codec's
`InvalidSfnt` instead of an answer of the validator. A version known only to the codec does not get
past the input.

Every offset is counted from the start of the file. A prefix is not skipped: a shifted head would
turn the check into a search for the marker anywhere.

`SfntReader` and `SfntFontValidator` read the table records through `SfntTableDirectory`
(`font-convertor/sfnt-table-directory/`), which checks the header size and the version and holds the
records by tag and in the order of the directory. It lies outside `eot-packer/` because the codec is
not its only reader: a second parse of the same directory would be a second copy of one format rule.
Its static `writeHeader()` writes the header of the sfnt that `WoffFontValidator` and
`Woff2FontValidator` rebuild in memory, so the search fields have one implementation too. The
validator checks the header before the directory parses it: the directory rejects a short file or an
unknown version with the codec's `InvalidSfnt`, while the validator names the rule broken.

## The SVG validator

`SvgFontValidator` (`validator/svg/`, a singleton in the container) reads the whole file and checks
it against W3C SVG 1.1 Second Edition, chapter 20 "Fonts". SVG 2 removed SVG fonts, so 1.1 is the
reference. `FontValidatorResolver` gives it out for an SVG source, and its answer leaves the pair
unchanged: `FontConvertor` wraps it in `FontConvertorError` as the cause, like any failure of the
pair. A rejected source never reaches the engine. The engine's SVG output is not checked: the
validator sees only the source.

It answers with a subclass of `InvalidSvgFont`, in this order: `NotXml`, `NotSvg`, `NoFont`,
`BrokenFont`. The order holds because the answers are given after one full pass over the document:
a file that breaks off halfway is "not XML" even if its well-formed head already broke a font rule.
Of several broken rules, `BrokenFont` names the first the pass met. Every answer names the source
in `path` of its payload, as the answers of the other validators do, so that the log says which file
was rejected.

- **Not XML.** The decoder is picked by the BOM: `FF FE` and `FE FF` are UTF-16, anything else
  UTF-8, since XML 1.0 §4.3.3 requires the BOM for UTF-16. `TextDecoder` runs with `fatal`, because
  bytes outside the encoding are a fatal error in XML. An encoding declaration naming another
  encoding than the one read is "not XML" too, even in an ASCII-only file that would read the same
  in both.
- **Not SVG.** The root is `svg` in the SVG namespace. A root without `xmlns` still counts under
  the SVG 1.1 DOCTYPE (`-//W3C//DTD SVG 1.1//EN`): the DTD declares `xmlns` of `svg` `#FIXED` to
  the SVG namespace (Appendix A.3.3), and Font Awesome 4.7 is written this way. It fixes
  `xmlns:xlink` the same way. The parser does not read the DTD, so the validator binds both prefixes
  itself (`resolvePrefix`).
- **No font, broken font.** Only the fonts are checked against the specification, not the rest of
  the document; the rules that look at the whole document are ours, below. The font nodes inside
  `font` count only as its direct children in the SVG namespace, and only unprefixed attributes
  are attributes of these elements. The rules are `FontRule` in
  `svg-font-validator.types.ts`; the text of each names its section, or says "ours" where fontforge
  asks more than the specification. Three of ours look at the whole document. It holds one `font`:
  a second font is the case of the `ttcf` collection above, fontforge 20230101 silently converts the
  first and drops the rest ([#664](https://github.com/yuldashevsardor/telegram-bot/issues/664)).
  The names of the font nodes, `FONT_NODE_NAMES` of `SvgFontValidator`, appear in it only on
  elements of the SVG namespace. fontforge finds these nodes by the local name alone
  (`_FindSVGFontNodes` and `SVGParseFont` of its `svg.c`), so it reads an element of any namespace
  and a processing instruction by its target as one of them, past the rules above. And its DOCTYPE
  has no internal subset: libxml2 gives fontforge the attribute defaults the subset declares, while
  saxes does not read it, so `<!ATTLIST glyph d CDATA "garbage">` would hand every glyph an outline
  the validator never sees. Two more of ours hold for the font nodes the rules check. fontforge
  reads their attributes by the local name too (libxml2 `xmlGetProp`), the first one in any
  namespace, so a font node has no prefixed attribute at all, whatever its name: a namespace
  declaration is no attribute. And a `glyph` or `missing-glyph` has no child elements: without `d`
  fontforge draws the glyph from its children as any SVG (`SVGParseGlyphBody` hands the glyph to
  `SVGParseSVG`: `g`, `use`, the shapes and `image` by the local name), past every rule here, and
  next to `d` it drops them, while SVG 1.1 draws both. The rule takes `title` and `desc` too, and
  it rejects what fontforge itself exports with children (`svg_scpathdump`): a stroked font, whose
  glyph is a `g` around a `path`, and a multilayer one, whose glyph is nested `g`, `path` and
  `image` without `d`. The owner took that price for the narrowest rule. A processing instruction
  in a glyph counts as a child too: libxml2 names it by its target, so `<?path?>` reaches the same
  dispatch. Measured, fontforge draws such a glyph empty, as one without children, since the
  instruction has no attributes to read; the rule does not lean on that. None of the six icon fonts
  checked for #766 (Font Awesome 4.7 and 5, Glyphicons, Ionicons, Material Design Icons, Weather
  Icons; about 5,000 glyphs) has a child element in a glyph, a prefixed attribute on a font node or
  an internal subset. Measured on 20230101
  ([#756](https://github.com/yuldashevsardor/telegram-bot/issues/756),
  [#766](https://github.com/yuldashevsardor/telegram-bot/issues/766)): an `x:glyph` with
  `d="garbage"` in a valid font, an `x:d="garbage"` before a valid `d`, or a default `d="garbage"`
  from the internal subset sends fontforge into a loop that prints
  `Unknown type 'g' found in path specification` without end; an `x:font-face` without
  `units-per-em` or a `<?font?>` before the font fails its open; a `<path d="garbage"/>` in a glyph
  without `d`, or a `use` that refers to its own parent, kills it with a segmentation fault; and an
  `x:unicode="b"` before `unicode="a"`, or a default `unicode` from the subset, maps the glyph to
  `b` without a word. The node rule holds in the prologue too, though fontforge reads only below
  the root: no real font holds such a node. It holds for every name alike: a `<?hkern?>` is
  rejected, though fontforge, finding no `k` on an instruction, skips it. A foreign element is
  quoted in Clark notation, `{urn:x}glyph`, so that it does not read as an SVG one, an instruction
  as `?font?`, the DOCTYPE as `!DOCTYPE`, and a prefixed attribute by its qualified name.
  The outline, `d` of `glyph` and `missing-glyph`, is read by `readPathData()` (`path-data.ts`)
  against the path data grammar of §8.3.9, which §20.4 gives it. Numbers there are read greedily,
  as §8.3.9 requires ("must consume as much of a given BNF production as possible"), and `1.` is a
  number, unlike in the other attributes. Past the grammar `isOutlineWithinRange()`
  (`outline-range.ts`) follows the current point through the commands and checks the points of the
  outline, described below with the other ranges.
  The kerning pairs, `hkern` and `vkern` children of `font`, are checked against §20.7: each has
  `k`, a `<number>`, and names both glyphs, by `u1` or `g1` and by `u2` or `g2`; a `g1` or `g2`
  of commas and XML whitespace alone names none. fontforge
  (`SVGParseKern`) skips a pair without `k` or without a glyph, and reads the number at the head of
  `k`, so `12garbage` kerns by 12. One rule is ours: `u1` and `u2` hold one character each.
  fontforge reads them as a string of characters, not as the comma-separated list of §20.7, so the
  list `a,b` kerns the comma too, the range `U+0061-0062` kerns nothing, and the
  ligature `ab` kerns `a` and `b`. The names in `g1` and `g2` are not checked: fontforge splits
  them at commas and whitespace, as the list of §20.7 is split. A name no glyph has, and a `u1` or
  `u2` character no glyph has, fontforge drops without a word.
  Measured on 20230101 for [#776](https://github.com/yuldashevsardor/telegram-bot/issues/776), with
  24 real SVG fonts with kerning found on GitHub: 20,882 `hkern` and no `vkern`. Every pair has an
  integer `k` and both glyphs, `u1` and `u2` are always one character, and `g1` and `g2` hold
  lists in 2,241 pairs. A grammar check of `u1` by §20.7, where the comma separates, would stumble
  on `u1=","`, which 13 of the 24 fonts hold. None of the fonts breaks a kerning rule; two break
  older ones, a Batik sample with a `g` in a glyph and a libmsvg sample with `xml:id` on its font.
  The numbers fontforge carries into the font have a range each, ours, by where fontforge keeps them
  (`strtod` in its `svg.c`, then a field of the font): past it fontforge writes another value
  without a word. A range holds the number as written, and `1e999`, out of a double, is past every
  range. `horiz-adv-x` and `vert-adv-y` of `font`, `glyph` and `missing-glyph` are 0 to 32767:
  fontforge keeps an advance in a signed 16-bit field, narrower than the unsigned one of `hmtx`, so
  `32768` makes 0 in a TTF and `70000` makes 4464. `k` is -32767 to 32767: fontforge keeps it
  negated in the same kind of field, so `40000` kerns by 25536 and `-32768` wraps over to the
  opposite sign; `32768` would fit, and the range is kept symmetric. A fraction in range is
  truncated, as in the other fields: `k="12.6"` kerns by 12. `units-per-em` is 16 to 16384,
  the range of `unitsPerEm` in the OpenType `head` table; fontforge writes 15 or 16385 as it is.
  The sfnt validator holds the same bound as a rule of its own (`head.unitsPerEm` in
  [The sfnt validator](#the-sfnt-validator), with the Apple floor of 64 it leaves out): a change of
  one is weighed against the other.
  `ascent` and `descent` of `font-face`, numbers by §20.8.3, are -32767 to 32767: fontforge takes
  them when they add up to `units-per-em` and writes them into signed 16-bit fields, so
  `ascent="40000" descent="-39000"` gives an ascender of -25536; they are checked whether or not
  they add up. A fraction is let through: fontforge truncates it (rounds `units-per-em`), and real
  fonts hold fractional advances. One just past a bound is rejected, though fontforge would bring
  `32767.6` back to 32767: no real font comes near a bound. The origins, `horiz-origin-x`,
  `horiz-origin-y`, `vert-origin-x` and `vert-origin-y`, have no range: fontforge does not read
  them. The other numbers of `font-face`, such as `underline-position` or `slope`, are not checked
  at all. The numbers of `d` have no range of their own: the font stores points, not these numbers,
  and a relative command adds to the current point. What is bounded is the points
  (`isOutlineWithinRange()`; measured on 20230101 for
  [#798](https://github.com/yuldashevsardor/telegram-bot/issues/798) with about 1,400 random
  outlines, run through `fontforge.open()` and `generate()` to all four targets, the box of each
  glyph read back):
  - A TrueType outline (TTF, WOFF2) stores each point as a signed 16-bit shift from the point
    before it, from the origin for the first point and from the last point of the contour before
    for the first point of the next contour. A shift of `32768` wraps: `M0 0l32768 0l0 700z`
    comes back from -32768 to 0. A CFF outline (OTF, WOFF) shifts the same way, but draws the
    closing line of a contour and shifts the next moveto from the start of the contour before, so a
    closing line or a moveto past the range breaks it. The validator does not know which target the
    font goes to, so a shift past the range in either is rejected.
  - The box of a glyph, in the `glyf` header and in `hmtx`, is signed 16-bit as well. fontforge
    reads points past it back right, so a readback does not show it; the file does. For
    `M30000 0l30000 0l0 700l-30000 0z`, which reaches 60000 through shifts in range, the header
    says an `xMax` of -5536. So each point must lie in -32767 to 32767 too, however it was reached.
  - The points checked are the end points, the control points of curves (a curve lies in the hull
    of its control points), the end point of an arc and the control points a smooth command
    reflects. Two cases are rejected though fontforge would store them: a control point past the
    range of a curve whose points are within it, and the controls of two quadratic curves in a row
    more than 32767 apart. The second is there because a TrueType outline drops the on-curve point
    between two off-curve ones when it is their midpoint:
    `M2933 -287q27724 21719 2967 3562t-4115 424Z` comes back 64,000 wide.
  - An arc is checked by its end point and by its radii, each at most 32767, unless one radius is
    zero: such an arc is a straight line (§F.6.2), so only its end point counts. The points
    fontforge builds on it are not followed. A flat arc of the radius 50000 is rejected though
    fontforge stores it, and `M0 0a30000 30000 0 1 1 700 0z`, a radius in range, is let through
    though the header of its TTF says a `yMin` of 5538 for a glyph that reaches -59997. Radii from
    about 46000 broke the readback of OTF and WOFF.
  - Of about 1,400 outlines, none let through came back wrong in the readback. 300 cubic and 200
    quadratic ones, built to be let through, had control shifts up to 32000.
  - A moveto with nothing drawn after it is checked, though fontforge drops it. One result is not
    explained: `M32767 0l10 0l0 700z` comes back whole from an OTF and empty from a WOFF.

  Within the ranges of the attributes the targets agree: TTF, OTF, WOFF and WOFF2 were measured, and
  EOT is built from the TTF. Measured on 20230101 for
  [#792](https://github.com/yuldashevsardor/telegram-bot/issues/792), with 132 distinct real SVG
  fonts gathered for the earlier issues: none holds a number past its range, the widest advance is
  3169, `k` stays within ±1024, and `units-per-em` runs from 96 to 2048. fontforge takes `ascent`
  and `descent` in 22 of them, and 17 glyph advances in 5 are fractional.
  The outline rule was run on 163 other real SVG fonts found on GitHub with `gh search code`
  (8,180 outlines of `glyph` and `missing-glyph`): all are path data, none is rejected.

XML is parsed with `saxes` (XML 1.0 fifth edition and Namespaces in XML, non-validating). It was
chosen by measurement, with expat as the reference: of 38 malformed documents it accepted none,
while `@xmldom/xmldom` 0.9.12 accepted 6 even with every level it reports escalated (`&#0;`, a bare
`&`, `]]>` in text, a control character, NUL, rebinding the `xml` prefix). Both reject a document
that uses an entity declared in its own DOCTYPE; none of the 26 distinct real SVG fonts checked
for [#610](https://github.com/yuldashevsardor/telegram-bot/issues/610) does. The price:
the repository of `saxes` is archived and the last release is 6.0.0 of 2021, so a bug found in it
will not be fixed upstream. It loads no external files and expands no entities beyond the
predefined ones.

`saxes` is created with `forceXMLVersion`: by the fifth edition of XML 1.0 a document declaring
another 1.x version is read as 1.0. Without an error handler it throws a bare `Error`; the handler
turns it into `NotXml`, and the encoding check reports through the same `parser.fail()`. The
`NotXml` keeps only the message, cut, not the saxes error as its cause: that message quotes names
from the file, and a cause reaches the log uncut.

Text from the file reaches the log through the answers, so each piece of it is cut
(`svg-font-validator.errors.ts`): the saxes message to `MAX_PARSER_MESSAGE_LENGTH` UTF-16 units, the
namespace and the local name of a `NotSvg` root and of a `BrokenFont` element, the target of a
`BrokenFont` instruction inside its `?…?`, the prefix and the local name of a `BrokenFont`
attribute, and its value, each to `MAX_QUOTED_LENGTH`. A cut piece ends with `…`, which makes it
one unit longer than an uncut piece can be: that, not the text, tells it from a piece that ends
with `…` itself.
This holds for every piece quoted from the file in the payload and in the `NotXml` message; `path`
is not text from the file and is not cut. The `NotSvg` and `BrokenFont` messages escape what they
quote with `JSON.stringify`, which can make it longer. The `BrokenFont` value is escaped inside its
quotes, and its `…` stands outside them, where the escaped value cannot reach. The quoted element or
root is escaped without the quotes, so that an XML line end in a namespace does not split the
message, and a `}` in a namespace stays, since the local name follows the last one; there the length
tells nothing, and the payload, which keeps the quote unescaped, tells a cut piece. The payload also
keeps the length before the cut:
`valueLength` of the value, which, like the length of `value`, tells a cut value, and `rootLength`
of the whole root, which does not say which of its two pieces was cut. The element and the
attribute name keep none.

## The WOFF validator

`WoffFontValidator` (`validator/woff/`, a singleton in the container) reads the whole file and
checks the container against W3C Recommendation "WOFF File Format 1.0" (13 December 2012): the
header (§4), the table directory (§5), the tables and their compression (§5, §6), and where the
blocks lie in the file (§3, §7, §8), then the sfnt the container carries (below).
`FontValidatorResolver` gives it out for a WOFF source, and its answer reaches the caller the way
the SVG one does: as the cause of `FontConvertorError`, before the engine is called. The engine's
WOFF output is not checked either. The validator exists because the engine does not refuse a broken
container: of the 46 invalid container files of the W3C test suite fontforge 20230101 converts 34
([#685](https://github.com/yuldashevsardor/telegram-bot/issues/685)).

About the container it answers with a subclass of `InvalidWoffFont`
(`woff-font-validator.errors.ts`): `NotWoff` for a file shorter than the 44-byte header or without
the `wOFF` signature, `BrokenWoff` for the first broken rule. The order in which the rules are
checked is in the comment of `validate()`. A file that cannot be read fails with `ReadFailed` of
`FileHelper`, not with an answer about the font. Every answer names the source in `path` of its
payload. Unlike the SVG answers, nothing in them is cut: the only text from the file they quote is
a table tag, four bytes long. A zlib failure keeps the zlib error as the cause, since its message
comes from zlib, not from the file.

A valid container is not yet a valid font: the standard "does not guarantee that the actual font
data packaged in a valid WOFF container is in fact correct and usable" (§3), and fontforge
converts with exit 0 a WOFF whose font lacks `head`, `cmap` or another required table
([#687](https://github.com/yuldashevsardor/telegram-bot/issues/687)). So from the inflated tables
the validator rebuilds, in memory, the sfnt they were packed from, as §5 and §6 describe
(`WoffFontValidator.sfnt()`), and hands the bytes to `SfntFontValidator.validateBytes()`. The sfnt
validator's answer, a subclass of `InvalidSfntFont` naming the WOFF file in `path`, passes through
as the WOFF validator's own. The rebuild repeats what the container has confirmed, so the sfnt
rules on the header and the table records cannot fail there. Those on which tables the font has and
on their content, `checkTables()` and `checkContent()` of `SfntFontValidator`, can.

The rules are `WoffRule` in `woff-font-validator.types.ts`, each with its section. Two of them are
ours, not the standard's, and the text of each says why: the flavor is one of `SFNT_VERSIONS` (see
"Signatures"), and `totalSfntSize` is at most 32 MiB, checked before any table is inflated. The
measurement behind the cap is at `MAX_SFNT_SIZE_BYTES`.

What is deliberately not checked, with the reasons, is in the class comment of `WoffFontValidator`:
`head.checkSumAdjustment` of the rebuilt sfnt, which 28 % of real fonts fail while fontforge
converts them; the content of the metadata block, which §7 tells a user agent to ignore when
invalid; and the flavor against the outline tables, since the sfnt validator does not tie the
version to the outlines.

## The WOFF2 validator

`Woff2FontValidator` (`validator/woff2/`, a singleton in the container) reads the whole file and
checks the container against W3C Recommendation "WOFF File Format 2.0" (8 August 2024): the header
(§3.2), the table directory (§4), where the blocks lie in the file (§3, §6, §7), the compressed data
(§5), and the transformed tables (§5.1–§5.4). The header and the metadata block are those of "WOFF
File Format 1.0" apart from Brotli (§3.2, §6), so some rules come from it. `FontValidatorResolver`
gives it out for a WOFF2 source, and its answer reaches the caller the way the SVG one does: as the
cause of `FontConvertorError`, before the engine is called. The engine's WOFF2 output is not
checked.

The validator exists because the engine does not answer a broken container. fontforge 20230101
reads WOFF2 through Google's reference decoder, `libwoff2dec` 1.0.2. When the decoder refuses a
file, fontforge does not report it: it prints `Couldn't find a font file named` with garbage bytes
as the name and dies with SIGABRT, or SIGSEGV on the same file in another run, and the user gets
`ExecuteError` without a reason. Of 74 variants of the fixture, each breaking the container in one
place, fontforge crashed on 67 and converted 4 with exit 0; one of the 4, `hmtx` with transform
version 2, damages 1292 of 1296 advance widths. Of 5796 real WOFF2 fonts from 28 npm packages the
validator accepts every one ([#616](https://github.com/yuldashevsardor/telegram-bot/issues/616)).

It answers with a subclass of `InvalidWoff2Font` (`woff2-font-validator.errors.ts`): `NotWoff2` for
a file shorter than the 48-byte header or without the `wOF2` signature, `BrokenWoff2` for the first
broken rule. The order in which the rules are checked is in the comment of `validate()`. A file that
cannot be read fails with `ReadFailed` of `FileHelper`, not with an answer about the font. Every
answer names the source in `path` of its payload. Nothing in them is cut: the only text from the
file they quote is a table tag, four bytes long. A Brotli failure keeps the zlib error as the cause,
since its message comes from Node's Brotli decoder, not from the file.

`GlyfReconstructor` (`validator/woff2/glyf-reconstructor.ts`) reads a transformed `glyf` glyph
record by glyph record, rebuilds `glyf` and `loca` from it and a transformed `hmtx` from the `xMin`
of the glyphs, and answers on the first record it cannot decode. Without it a broken record reached
the engine, which crashed on each of 12 such variants of the fixture. Where §5.1 leaves the bytes
open, it writes them the way the engine's decoder does, so that the decoder's output checks it: its
class comment lists those choices. The rebuilt `glyf` and `loca` equal those of `woff2_decompress`
1.0.2, byte for byte, on all 5742 TrueType fonts of the 5796. No real font transforms `hmtx`: on the
fixture with the `hmtx` transform the rebuilt `hmtx` equals the fixture's own, as the decoder's does
([#736](https://github.com/yuldashevsardor/telegram-bot/issues/736)).

The rules are `Woff2Rule` in `woff2-font-validator.types.ts`, each with its section. Those marked
`ours:` are not the standard's, and the text of each says why;
`grep -n 'ours:' src/font-convertor/validator/woff2/woff2-font-validator.types.ts` lists them. What
the enum text lacks is the measurements:

- `origLength` of a transformed `hmtx`: `woff2_decompress` 1.0.2 refuses the fixture with the
  `hmtx` transform and `origLength` 5185 against 5184 rebuilt bytes. A smaller `origLength` passes
  the decoder and is not this rule's: it leaves a table record shorter than the bytes written, so
  the rebuilt `hmtx` record carries `origLength` and the sfnt validator catches the table that is
  too short for its glyphs;
- a rebuilt `glyf` over 131 070 bytes with `indexFormat` 0: the decoder of `woff2_decompress` 1.0.2
  cuts each halved offset to 16 bits, so the `loca` it writes wraps past 128 KiB and the later
  glyphs point at the wrong records, and §5.3 has nothing for an offset that does not fit. The rule
  `ShortLocaGlyfSize` rejects it in `GlyfReconstructor`, before the sfnt is rebuilt;
- the padding of the compressed data that ends the file: fontforge crashes on the fixture cut by
  its 3 padding bytes;
- the two caps on the decompressed tables, 30 MiB and 100 times the file size, are checked on the
  sum of the table lengths in the directory, before Brotli runs; the measurement behind them is at
  `DECODER_BUFFER_SIZE_BYTES`;
- the cap on the rebuilt sfnt: the reconstruction makes `glyf` larger than its transformed form, by
  31 546 bytes on the fixture.

What is deliberately not checked, with the reasons, is in the class comment of
`Woff2FontValidator`: `reserved`, `totalSfntSize` and `origLength` of a transformed `glyf`, on which
the standard forbids a reader to reject a file (§3.2, §5.1); the content of the metadata block,
which a reader ignores (§6, WOFF 1.0 §7), so only its bounds are checked; the flavor against the
outline tables; and a known tag written out after flag 63, which the standard lets a decoder accept.

The standard checks the packaging only, so once the container passes, the sfnt it carries is
rebuilt in memory and handed to `SfntFontValidator.validateBytes()`, whose answer passes through as
the WOFF2 validator's: the flavor is the version, the directory is in ascending tag order (§2), each
table lies on a 4-byte boundary, and the records carry no checksums, which the sfnt validator does
not check. The table rules, CFF2 among them, are the sfnt validator's. It is the same hand-over as
in the WOFF validator. Without it fontforge converted 24 of 25 variants of the fixture with the
enclosed sfnt broken in one place with exit 0, 18 of them into an output that differs from the
fixture's, such as lost glyphs or encodings
([#737](https://github.com/yuldashevsardor/telegram-bot/issues/737)).

## The EOT validator

`EotFontValidator` (`validator/eot/`, a singleton in the container) reads the whole file and checks
the envelope against W3C Member Submission "Embedded OpenType (EOT) File Format" (5 March 2008): the
fixed part of the header (§3), the blocks of its version (§3.1–§3.3), that the font follows the
header directly and ends the file (§3), and `RootStringCheckSum` of version `0x00020002` (§4.3.2).
It reads the header through `EotHeader` (see "EOT"). `FontValidatorResolver` gives it out for an EOT
source, and its answer reaches the caller the way the SVG one does: as the cause of
`FontConvertorError`, before the codec is called. The validator exists because neither the codec nor
the engine refuses a broken envelope: of 27 variants of the fixture, each breaking one rule of the
submission, `EotPacker.unpack()` rejected 12, and fontforge 20230101 converted the other 15 with
exit 0 and every glyph, since it never sees the envelope
([#617](https://github.com/yuldashevsardor/telegram-bot/issues/617)). On `eot → ttf` the engine is
not called at all.

About the envelope it answers with a subclass of `InvalidEotFont` (`eot-font-validator.errors.ts`):
`NotEot` for a file shorter than the 82-byte fixed part of the header or without the `MagicNumber`,
`BrokenEot` for the first broken rule. The order in which the rules are checked is in the comment of
`validate()`. A file that cannot be read fails with `ReadFailed` of `FileHelper`, not with an answer
about the font. Every answer names the source in `path` of its payload. Nothing in the answers is
cut: the only things from the file they quote are numbers. Two answers keep another error as the
cause. A file that ends inside a field the parse reads (the Padding or the size of a block, or
`EUDCFlags` and `EUDCFontSize` of version `0x00020002`) keeps the `InvalidEot` of `EotHeader`. A
`FontData` that does not decode keeps the `InvalidEotPayload` of the decoder (below).

The rules are `EotRule` in `eot-font-validator.types.ts`, each with its section. None is ours: a
compressed or encrypted `FontData` is read, as the submission asks of a user agent (§2.3). The last
rule, `FontDataDecodes`, is that `FontData` decodes under its flags by `EotPayloadDecoder` (see
"EOT"). Its answer names W3C Member Submission "MicroType Express (MTX) Font Format".

A valid envelope is not yet a valid font. The submission makes the enclosed font part of the format:
`FontData` is "a TrueType or OpenType font" (§3). The codec checks only its sfnt header and table
records on unpacking, and on `eot → ttf` the unpacked sfnt is the result: of 15 variants of the
fixture with a broken enclosed font the codec rejected 4, and `eot → ttf` returned the other 11
([#740](https://github.com/yuldashevsardor/telegram-bot/issues/740)). So the validator hands the
decoded `FontData` to `SfntFontValidator.validateBytes()`, last, once the envelope holds.
A compressed or encrypted `FontData` is decoded by the validator itself, so its font gets an answer
before the pair starts, as the font of every other format does. `EotPacker.unpack()` decodes it a
second time. On the 120 real compressed files that took at most 34 ms per file, 1.1 s in all
([#741](https://github.com/yuldashevsardor/telegram-bot/issues/741)), and readability comes first.
The sfnt validator's answer, a subclass of `InvalidSfntFont` naming the EOT file in `path`, passes
through as the EOT validator's own, as it does for WOFF. Unlike the rebuilt sfnt of a WOFF, the sfnt
of `FontData` can break the sfnt rules on its size, and then "the file" of the answer is that sfnt,
not the EOT file its `path` names: the size `NotSfnt` and `DirectoryInFile` give and "the file size"
of `TableInFile` are those of that sfnt. XOR decodes any bytes, so an encrypted `FontData` that
holds no font gets the answer of the sfnt validator, not of `FontDataDecodes`.

`EotPacker.unpack()` keeps its own checks: the validator replaces none of them. Every source it
unpacks has passed the validator first.

What is deliberately not checked, with the reasons, is in the class comment of `EotFontValidator`.

## The sfnt validator

`SfntFontValidator` (`validator/sfnt/`, a singleton in the container) reads the whole file and
checks it, or takes from `WoffFontValidator` and `EotFontValidator` (above) the bytes of the sfnt a
WOFF or an EOT carries, and checks them against the Microsoft OpenType specification 1.9.1 and, for
what it governs, Apple's TrueType Reference Manual: the table directory ("Table Directory"), the
tables a font must have ("Required Tables"), and the fields of each table by its own section. Which
fields of which tables it reads is in the class comment of `SfntFontValidator`.
`FontValidatorResolver` gives it out for a TTF and an OTF source alike, and its answer reaches the
caller the way the SVG one does: as the cause of `FontConvertorError`, before the engine is called.
The engine's TTF and OTF output is not checked. The validator exists because the engine does not
refuse a broken sfnt: of 104 variants of the fixtures, each broken in one place, fontforge 20230101
converted 79 with exit 0, 9 of them losing glyphs or outlines, and crashed on 8 with SIGSEGV
([#614](https://github.com/yuldashevsardor/telegram-bot/issues/614)).
`ttf → eot` does not reach the engine at all: `EotPacker.pack` reads `OS/2`, `head` and `name` and
packs whatever else the font holds.

It answers with a subclass of `InvalidSfntFont` (`sfnt-font-validator.errors.ts`): `NotSfnt` for a
file shorter than the 12-byte header or of a version outside `SFNT_VERSIONS`, `BrokenSfnt` for the
first broken rule. The order in which the rules are checked is in the comment of `validateBytes()`.
A file that cannot be read fails with `ReadFailed` of `FileHelper`, not with an answer about the
font. Every answer names the source in `path` of its payload, the WOFF or the EOT file for the sfnt
it carries. Nothing in the answers is cut: the only text from the file they quote is a table tag,
four bytes long.

The rules are `SfntRule` in `sfnt-font-validator.types.ts`, each with its section. Four of them are
ours, not the standard's, and the text of each says why: a collection is rejected (see
"Signatures"); so is a font with a `CFF2` table, which the standard allows but fontforge 20230101
does not open (exit 1, "not in a known format"); so is a `cmap` without subtables, of which the
standard sets no count; and so is a `post` 2.0 or 2.5 with fewer glyph names than `maxp` has glyphs,
of which the standard says only that the two counts should be the same. Where the two references
differ, the rules follow the one that governs the outlines present, with three exceptions, the last
three items:

- `OS/2` is required only with CFF outlines. Microsoft requires it of every font, Apple's manual
  (chapter 6) not of a TrueType one. Without it the engine builds the table itself: every glyph is
  kept, but the embedding restriction of `fsType` and the bold bit of `fsSelection` are lost.
  `ttf → eot` fails on such a font in `SfntReader` with `InvalidSfnt`.
- The version does not have to match the outlines: `OTTO` over `glyf` and `0x00010000` over
  `CFF ` pass, since the specification says "should" and the engine converts both keeping every
  glyph. A rule that depends on the outline type goes by the outline tables present, not by the
  version: `OS/2` above, the version of `maxp` (0.5 with `CFF `, 1.0 with `glyf`), and `loca` and
  `glyf`, which are read only with TrueType outlines.
- `head.unitsPerEm` goes by OpenType for every font: 16 to 16384, of which the specification says
  "Any value in this range is valid", as #682 sets it. Apple's manual (chapter 6, `head`) gives a
  TrueType font 64 to 16384; that floor is not applied, so a TrueType font of 16 to 63 units passes.
- The versions of `name` and `post` go by OpenType for every font, as #683 sets them. A TrueType
  font passes with a version 1 `name`, of which Apple's manual (chapter 6, `name`) says "not
  supported on Apple platforms", and fails with a version 4.0 `post`, which the manual defines but
  says "should be avoided" and OpenType does not support. None of the 543 real fonts measured has
  either.
- The glyph-name index of `post` 2.0 goes by OpenType for every font: from 258 to 65535 it points at
  a string. Apple's manual (chapter 6, `post`) reserves 32768 to 65535 "for future use"; a TrueType
  font with such an index is held to the string it points at all the same, and fails without one.
  fontforge 20230101 reads the index as OpenType does: a glyph of the TrueType fixture given 65535
  is renamed to `glyphN` ([#757](https://github.com/yuldashevsardor/telegram-bot/issues/757)).

The rules on `head`, `maxp`, `hhea`, `hmtx` and `loca` are those where the engine converts a broken
font with exit 0 and loses glyphs, measured on the TrueType fixture of 1296 glyphs: `maxp.numGlyphs`
cut by 100 leaves 1196, `numGlyphs` 0 leaves 3, `indexToLocFormat` 2 leaves 649, a `loca` descending
at one glyph or ending past `glyf` drops that glyph
([#682](https://github.com/yuldashevsardor/telegram-bot/issues/682)). The other fields they read
the engine forgives, but the standard does not. The length of `hmtx` and of `loca` is a minimum, not
an exact size: none of the 297 real fonts with TrueType outlines measured has either table longer
than its fields, so the stricter form would buy nothing.

The rules on `glyf` walk every glyph with an outline, `loca[n] < loca[n+1]`: its 10-byte header,
and in a simple glyph whether `endPtsOfContours`, the instructions, the flags with their repeats
and the coordinates of the widths the flags give fit into its length by `loca`, the contour ends
increasing and one flag per point
([#684](https://github.com/yuldashevsardor/telegram-bot/issues/684)). Of the breaks measured on the
TrueType fixture the engine converts every one with exit 0 but a single conversion, to WOFF2 with
the instructions past the glyph, which fails with exit 1: a `glyf` filled with garbage keeps all
1296 glyphs and loses every outline, 16 KB of WOFF against 72 KB; contour ends past the glyph or
descending drop its outline, with "contour ends make no sense"; a glyph whose instructions run
past it, or which is cut inside its flags, is read on into the next glyph and its points change,
with "Flag count is wrong"; a glyph cut inside its coordinates takes the missing bytes from the
next glyph, with "A point … is outside the glyph bounding box". Two rules follow the standard,
not the engine, which loses nothing on what they reject: `EndPtsAscending` on equal contour ends,
an empty contour, and `FlagPerPoint` on flag repeats past the last point, which the engine cuts
short with "Flag count is wrong". A composite glyph is one of a negative `numberOfContours`: the
specification says -1 "should be used", and the engine reads -2 and -32768 as a composite glyph too.
Its components are walked as the specification lays them out: at least one, each with its flags,
`glyphIndex`, arguments and transform inside the glyph, the instructions after the last one when any
component sets `WE_HAVE_INSTRUCTIONS`, every `glyphIndex` below `numGlyphs`, and no cycle among the
composite glyphs, a glyph that is its own component included
([#767](https://github.com/yuldashevsardor/telegram-bot/issues/767)). The engine loses the outline
of a composite glyph cut inside a component, of one whose component points past `numGlyphs`, and of
one on a cycle. Two cases follow the standard, not the engine: `MORE_COMPONENTS` on the last
component with no bytes left, on which the engine says "Bad flags value" and loses nothing, and
`WE_HAVE_INSTRUCTIONS` on a component before the last, which the engine reads on the last one only.
On that flag the rule takes the prose of the specification, "if the flag is set on any component
glyph", over its own pseudo-code, which reads the flag of the last component as the engine does.
The reserved bits of the component flags are not checked, since real fonts set them, nor is a
component held to one scale flag at most; the class comment of `SfntFontValidator` gives the
measurement for both.
None of the 297 real fonts with TrueType outlines measured breaks a `glyf` rule.

The rules on `cmap`, `name`, `OS/2` and `post` check where the records point, not what lies there:
neither the content of a `cmap` subtable past its format and length, nor the text of a `name` string
or of a `post` 2.0 glyph name. Of the glyph names only where they lie is checked, up to the last
string an index points at; the strings past it are not read. Every break they catch the engine
either converts keeping every glyph, some of them losing content, crashes on, or runs on past 60 s
([#683](https://github.com/yuldashevsardor/telegram-bot/issues/683),
[#752](https://github.com/yuldashevsardor/telegram-bot/issues/752),
[#757](https://github.com/yuldashevsardor/telegram-bot/issues/757)): a `cmap` without subtables, or
whose every subtable offset points into its header and records or past where the fields of a
subtable up to its length fit, loses the encoding, with "Could not find any valid encoding tables";
a subtable shorter than the part of its format of a set size, at the end of `cmap`, has the engine
read that part from the next table or from past the end of the file: of 20 variants it lost the
encoding in 15 and made a wrong one up in 3, and on format 12 at the end of the file it ran past
60 s in both fixtures, writing over 100 MB of "Bad font: Encoding data out of range." to stderr; a
`name` with 60000 records gives "Invalid mac encoding 65535"; a `name` string past the table crashed
fontforge with SIGSEGV in every conversion in 7 of the 14 variants measured and put foreign bytes
into the full name in 2; a `post` 2.0 cut to its 32-byte header renames 399 glyphs of the TrueType
fixture, those without an encoding, to `glyphN`, and a `post` 2.0 or 2.5 whose `numGlyphs` is below
that of `maxp` renames the glyphs past it, 401 with `numGlyphs` 0; a glyph name the index points at
that is missing from `post` is renamed to `glyphN`, one the table cuts short is cut short, and one
read past the end of the file carries a 0xFF byte into the name of the output, which is then not
UTF-8; an undefined format over the Unicode subtable of the fixture leaves 225 of its 893 encoded
glyphs, those of the Macintosh one. Some breaks the rules follow the standard on, not the engine:
`name` records that run into the string storage convert with nothing lost, and so does a `cmap`
subtable whose length runs past `cmap`, up to 65535 for format 4, or falls short of the part of its
format of a set size while that part lies inside `cmap`, or a `cmap` whose one record points 2 bytes
into its header while another Unicode record holds; pointing at 0 or 4, one such record already
loses the encoding. The engine reads a `post` 2.0 name only up to the end of `post`: a string whose
length byte overstates it past the table, while its bytes lie inside, loses nothing, and the rule
rejects it all the same. An empty `name` string is not held to the table: it has no byte to read,
and the engine converts it at any offset. A `post` naming more glyphs than `maxp` has passes: the
engine loses nothing on it. Its entries past the glyphs of `maxp` are held to the strings all the
same: an entry of 2.0 pointing past them fails the font. With CFF outlines the engine takes the
glyph names from `CFF `, and no break of `post` measured loses one; the `post` rules apply to those
fonts too. None of these rules rejects a font of the 242 in the macOS system font folders, which the
validator walks in 0.3 s. The length `OS/2` needs by its version, and why version 0 passes
shortened, is in the comment of `OS2_LENGTHS_BYTES` in `SfntFontValidator`.

What is deliberately not checked, with the reasons, is in the class comment of
`SfntFontValidator`: the table checksums and `head.checkSumAdjustment`, which the engine does not
read, and `searchRange`, `entrySelector` and `rangeShift`, which the specification tells readers
not to rely on.

## The pair table

The pair table in `ConvertorFactory` is the only source of what the domain can do. The convertor is
picked from it, and `getSupportedExtensions()` is derived from it. The welcome promises that list to
the user ([`i18n.md`](./i18n.md)). A format declared in `Extension` but absent from the table does
not count as supported.

## Known

- Temporary files are not deleted (issue
  [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).
- An SVG source is read, decoded and parsed whole, synchronously, on the event loop of the bot, and
  the domain sets no limit on its size. A WOFF source is read whole too: its tables are inflated by
  the asynchronous `zlib.inflate`, off the event loop, but their checksums are summed and the sfnt
  is rebuilt from them on it. The 32 MiB cap bounds the inflated tables, not the file, and the
  rebuilt sfnt is a second copy of them of the same size. A TTF or OTF source is read whole as well,
  and its table directory, every `loca` offset, every glyph of `glyf` and the references between
  composite glyphs are walked on the event loop, as they are for the sfnt a WOFF or an EOT carries.
  An EOT source is read whole too, and its header is walked on the event loop. A compressed or
  encrypted `FontData` is decoded on it as well, synchronously and twice, by the validator and by
  the codec. The decoding has no output cap of ours and no timeout: on 600 damaged inputs it never
  hung under a 20 s limit, but nothing guarantees that
  ([#741](https://github.com/yuldashevsardor/telegram-bot/issues/741)). `mtx-decompressor` 1.8.0
  caps only its input to the rebuild: each of the three compressed streams may declare at most
  16 MiB and grow its buffer to at most 64 MiB (`MAX_OUT_LEN`, `MAX_OUT` in its `dist/index.js`).
  The sfnt it rebuilds from them has no cap: `glyf` grows as the streams describe it, and only the
  decoded `hdmx` table is held to 64 MiB (`MAX_OUTPUT_BYTES`). How much memory a small crafted file
  takes was never run: building the crafted input was blocked by a safety control of the agent's own
  tooling ([#789](https://github.com/yuldashevsardor/telegram-bot/issues/789)). Only a ceiling from
  the library's own caps is recorded, not a measurement: each of the three streams may legitimately
  return up to `MAX_OUT` (64 MiB) before `unpackMtx()` moves to the next one, so the three together
  can reach about 192 MiB; `dumpContainer()` then builds one sfnt buffer sized to the sum of those
  bytes, up to roughly the same 192 MiB again while the streams are still held, a peak on the order
  of 384 MiB from a `FontData` whose three declared output lengths sit in a handful of header bits,
  decoupled from the size of the compressed input itself. `populateGlyfAndLoca()` is outside this
  arithmetic: its per-glyph allocation is driven by `maxp`'s fields, not by the caps above. A WOFF2
  source is
  read whole as well: its compressed data is decompressed by the asynchronous
  `zlib.brotliDecompress`, off the event loop, but its table directory is walked on it, and its
  transformed `glyf` is decoded and rebuilt there, a second copy beside the decompressed tables. The
  30 MiB caps bound the decompressed tables and the rebuilt sfnt, not the file. The sfnt walk was
  measured: `validateBytes()` takes 34 ms on `Arial Unicode.ttf`, 22 MB and 50377 glyphs, against
  29 ms in the same run with the components of composite glyphs left unread; the engine converts
  the file in 2.5 s ([#684](https://github.com/yuldashevsardor/telegram-bot/issues/684),
  [#767](https://github.com/yuldashevsardor/telegram-bot/issues/767)). So was the WOFF2
  reconstruction: `GlyfReconstructor` takes 190–405 ms, the first run the slowest, on
  `IBMPlexSansKR-Light.woff2`, 439 040 bytes and 12 240 glyphs, among the slowest of the 5742
  TrueType real fonts. The caps allow far more: a transformed `glyf` of 31 071 818 bytes, 65 535
  simple glyphs of 235 points each, takes 1.5–1.9 s over three runs. Brotli packs it into 99 bytes,
  so a file of about 310 KB passes the ratio cap with it
  ([#736](https://github.com/yuldashevsardor/telegram-bot/issues/736)).
- `/font_generator` converts the fixed `test/fixtures/fonts/test-font.woff` into
  EOT/OTF/TTF/WOFF2. It answers with the **path** to the file as text; the file itself is not
  sent. A caught conversion error is written at `error` level through `Logger`
  ([`logging.md`](./logging.md)). The command is for debugging and does not go to production
  ([overview](./README.md)), so its input from the `test/` directory stays as it is.
- The codec does not read the EOT envelope through. It parses the names (`EotHeader.readNames()`),
  then takes the font as the tail of the file by `FontDataSize`: it does not read the tail of
  version `0x00020002` and lets any bytes between the names and the font through, rejecting only a
  header that runs past the font start. A source is checked before that: `EotFontValidator` requires
  the font to follow the header directly. So the gap matters only for an envelope that bypasses the
  validator, and no route of the domain unpacks one.
- An envelope built by `EotPacker` repeats the output of `ttf2eot` byte for byte, except for
  `fsType`. `ttf2eot` always writes zero there, declaring any font free to install. We carry
  `OS/2.fsType` over as is, following the specification. The byte-for-byte comparison test with
  the fixture rests on this.
