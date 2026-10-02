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
  → FontForge.convert(): fontforge -c '<script>' SRC DIST through ProcessHelper.run
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
(`TwoStepEotConvertor.throughIntermediate()`).

The `Convertor` classes of the EOT pairs inherit from two parents. They are kept apart so that no
pair class gets what it does not need:

- `EotConvertor` is the constructor for the pairs the codec alone is enough for (`ttf ↔ eot`).
  `TtfToEot` and `EotToTtf` declare both extensions and keep `convert()` to themselves: in
  `EotConvertor` there is nowhere for the body to move up to.
- `TwoStepEotConvertor` is the constructor, the intermediate path and the removal for the other
  eight pairs. Their bodies live in `ToEotConvertor` and `FromEotConvertor`. The eight classes
  are empty except for declaring the missing extension.

`EotPacker` (`eot-packer/`) is one of the five places on the conversion path where the domain parses
the content of a font, not just its first bytes; the others are the SVG, WOFF, EOT and sfnt
validators below. The EOT header duplicates the metadata of the enclosed font. `SfntReader` takes it
from the `OS/2`, `head` and `name` tables. The envelope holds four names, in UTF-16LE. The slant is
taken from `OS/2.fsSelection`, not from `head.macStyle`, which duplicates it. `ttf2eot` does the
same. Besides, in `macStyle` the slant is bit 1, and bit 1 of `fsSelection` means something else.

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
`FontDataSize` included, and exposes the rest: the codec itself checks the magic number, `EOTSize`,
the flags and that the names end before the font. `EotHeader` lies outside `eot-packer/` because the
codec is not its only reader: `EotFontValidator` below reads it too, and a second parse of the same
header would be a second copy of one format rule. The mask of the two flags below is a constant of
`EotHeader` for the same reason. A compressed (`TTEMBED_TTCOMPRESSED`) or encrypted
(`TTEMBED_XORENCRYPTDATA`) payload is rejected with an explicit `UnsupportedEotFlags` error; the
codec does not try to parse it.

## Running the engine

The engine is launched only through `ProcessHelper.run(file, args)`, a wrapper over
`child_process.execFile` ([invariant](./invariants.md)). The arguments go as an array, past
`/bin/sh`. Building the command as a string and calling `exec` is not allowed here, because the file
name comes from the user. The same technique removes the second level of interpretation, Python's:
the script reads the paths passed as arguments from `sys.argv`, they are not substituted into the
script text.

## Signatures

The source format is checked twice: by the extension of the name and by the content. The content is
checked by a `FontValidator` (`validator/`), each of which knows one format.
`FontValidatorResolver`, a singleton in the container, holds one validator per format and gives a
pair the one of its source format, so a pair holds the resolver and none of the checks. It builds
the signature validator itself; the SVG, WOFF, EOT and sfnt ones come from the container. For one
format, WOFF2, the validator is `SignatureFontValidator`: the first `headLength` bytes of the file
against the signature (`FontSignatureMatcher`, a singleton in the container). SVG has no signature:
its first bytes could say at most "this is markup", not "this is a font", so `SvgFontValidator`
below reads the whole document instead. WOFF has one, `wOFF`, EOT has one, `MagicNumber` at offset
34, and TTF and OTF have one, the sfnt version, but each is only the first rule of its container:
`WoffFontValidator`, `EotFontValidator` and `SfntFontValidator` below check it together with the
rest, so `FontSignatureMatcher` does not know them. The name is set by whoever sent the file, so the
extension alone cannot be trusted. The code recognises the formats itself, without an external tool.
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
sources: a TTF or OTF file and the sfnt a WOFF carries. Two more files pass through the codec that
the validator never saw: the intermediate sfnt from the engine on packing, and the envelope content
on unpacking. The codec checks less than the validator: the header size, the version and the bounds
of the tables it reads, not the rules below. But the two share one set of versions with a third
check, `SFNT_VERSIONS` in `font-convertor/sfnt-version.ts`, and `WoffFontValidator`
(`validator/woff/`) checks the flavor of a WOFF against it: the flavor is the version of the sfnt it
carries. The set must not become several lists, because a divergence breaks behaviour rather than
the build. A version known only to the validator still fails on input: the directory the validator
builds rejects it, with the codec's `InvalidSfnt` instead of an answer of the validator. A version
known only to the codec does not get past the input.

Every offset is counted from the start of the file. A prefix is not skipped: a shifted head would
turn the check into a search for the marker anywhere.

`SfntReader` and `SfntFontValidator` read the table records through `SfntTableDirectory`
(`font-convertor/sfnt-table-directory/`), which checks the header size and the version and holds
the records by tag and in the order of the directory. It lies outside `eot-packer/` because the
codec is not its only reader: a second parse of the same directory would be a second copy of one
format rule. The validator checks the header before the directory parses it: the directory rejects
a short file or an unknown version with the codec's `InvalidSfnt`, while the validator names the
rule broken.

## The SVG validator

`SvgFontValidator` (`validator/svg/`, a singleton in the container) reads the whole file and checks
it against W3C SVG 1.1 Second Edition, chapter 20 "Fonts". SVG 2 removed SVG fonts, so 1.1 is the
reference. `FontValidatorResolver` gives it out for an SVG source in place of a signature, and its
answer leaves the pair unchanged: `FontConvertor` wraps it in `FontConvertorError` as the cause,
like any failure of the pair. A rejected source never reaches the engine. The engine's SVG output
is not checked: the validator sees only the source.

It answers with a subclass of `InvalidSvgFont`, in this order: `NotXml`, `NotSvg`, `NoFont`,
`BrokenFont`. The order holds because the answers are given after one full pass over the document:
a file that breaks off halfway is "not XML" even if its well-formed head already broke a font rule.
Of several broken rules, `BrokenFont` names the first the pass met. Every answer names the source
in `path` of its payload, as `InvalidFontSignature` does for a signed format, so that the log says
which file was rejected.

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
  the document; the rules that look at the whole document are ours, below. `font-face` and
  `glyph` count only as direct children of `font` in the SVG namespace, and only unprefixed
  attributes are attributes of these elements. The rules are `FontRule` in
  `svg-font-validator.types.ts`; the text of each names its section, or says "ours" where fontforge
  asks more than the specification. Two of ours look at the whole document. It holds one `font`: a
  second font is the case of the `ttcf` collection above, fontforge 20230101 silently converts the
  first and drops the rest ([#664](https://github.com/yuldashevsardor/telegram-bot/issues/664)). And
  the names of the font nodes, `FONT_NODE_NAMES` of `SvgFontValidator`, appear in it only on
  elements of the SVG namespace. fontforge finds these nodes by the local name alone
  (`_FindSVGFontNodes` and `SVGParseFont` of its `svg.c`), so it reads an element of any namespace
  and a processing instruction by its target as one of them, past the rules above. It reads their
  attributes by the local name too (libxml2 `xmlGetProp`), the first one in any namespace, so a
  prefixed attribute of a name a rule reads breaks one more rule of ours. Measured on 20230101
  ([#756](https://github.com/yuldashevsardor/telegram-bot/issues/756)): an `x:glyph` with
  `d="garbage"` in a valid font, or an `x:d="garbage"` before a valid `d`, sends fontforge into a
  loop that prints `Unknown type 'g' found in path specification` without end, and an
  `x:font-face` without `units-per-em` or a `<?font?>` before the font fails its open. The node
  rule holds in the prologue too, though fontforge reads only below the root: no real font holds
  such a node. A foreign element is quoted in Clark notation, `{urn:x}glyph`, so that it does not
  read as an SVG one, an instruction as `?font?`, and a prefixed attribute by its qualified name.
  The outline, `d` of `glyph` and `missing-glyph`, is checked by `isPathData()` (`path-data.ts`)
  against the path data grammar of §8.3.9, which §20.4 gives it. Numbers there are read greedily,
  as §8.3.9 requires ("must consume as much of a given BNF production as possible"), and `1.` is a
  number, unlike in the other attributes.

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
namespace and the local name of a `NotSvg` root and of a `BrokenFont` element in Clark notation, and
the attribute name and value of a `BrokenFont`, each to `MAX_QUOTED_LENGTH`. A cut piece ends with
`…`, which makes it one unit longer than an uncut piece can be: that, not the text, tells it from a
piece that ends with `…` itself.
This holds for every piece quoted from the file, in the payload, in the `NotXml` and `NotSvg`
messages and for the element in the `BrokenFont` one; `path` is not text from the file and is not
cut. The `BrokenFont` message escapes the kept value with
`JSON.stringify`, which can make it longer, so there the `…` stands outside the quotes, where the
escaped value cannot reach. The payload also keeps the length before the cut:
`valueLength` of the value, which, like the length of `value`, tells a cut value, and `rootLength`
of the whole root, which does not say which of its two pieces was cut. The element and the
attribute name keep none.

## The WOFF validator

`WoffFontValidator` (`validator/woff/`, a singleton in the container) reads the whole file and
checks the container against W3C Recommendation "WOFF File Format 1.0" (13 December 2012): the
header (§4), the table directory (§5), the tables and their compression (§5, §6), and where the
blocks lie in the file (§3, §7, §8), then the sfnt the container carries (below).
`FontValidatorResolver` gives it out for a WOFF source in place of the signature, and its answer
reaches the caller the way the SVG one does: as the cause of `FontConvertorError`, before the
engine is called. The engine's WOFF output is not checked either.
The validator exists because the engine does not refuse a broken container: of the 46 invalid
container files of the W3C test suite fontforge 20230101 converts 34
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

## The EOT validator

`EotFontValidator` (`validator/eot/`, a singleton in the container) reads the whole file and checks
the envelope against W3C Member Submission "Embedded OpenType (EOT) File Format" (5 March 2008): the
fixed part of the header (§3), the blocks of its version (§3.1–§3.3), that the font follows the
header directly and ends the file (§3), and `RootStringCheckSum` of version `0x00020002` (§4.3.2).
It reads the header through `EotHeader` (see "EOT"). `FontValidatorResolver` gives it out for an EOT
source in place of the signature, and its answer reaches the caller the way the SVG one does: as the
cause of `FontConvertorError`, before the codec is called. The validator exists because neither the
codec nor the engine refuses a broken envelope: of 27 variants of the fixture, each breaking one
rule of the submission, `EotPacker.unpack()` rejected 12, and fontforge 20230101 converted the other
15 with exit 0 and every glyph, since it never sees the envelope
([#617](https://github.com/yuldashevsardor/telegram-bot/issues/617)). On `eot → ttf` the engine is
not called at all.

It answers with a subclass of `InvalidEotFont` (`eot-font-validator.errors.ts`): `NotEot` for a file
shorter than the 82-byte fixed part of the header or without the `MagicNumber`, `BrokenEot` for the
first broken rule. The order in which the rules are checked is in the comment of `validate()`. A
file that cannot be read fails with `ReadFailed` of `FileHelper`, not with an answer about the font.
Every answer names the source in `path` of its payload. Nothing in the answers is cut: the only
things from the file they quote are numbers. Two answers keep another error as the cause: a file
that ends inside a field the parse reads (the Padding or the size of a block, or `EUDCFlags` and
`EUDCFontSize` of version `0x00020002`) keeps the `InvalidEot` of `EotHeader`, and the enclosed font
keeps the `InvalidSfnt` of the codec.

The rules are `EotRule` in `eot-font-validator.types.ts`, each with its section. One is ours, not
the submission's, and its text says why: a payload compressed with MicroType Express
(`TTEMBED_TTCOMPRESSED`) or XOR-encrypted (`TTEMBED_XORENCRYPTDATA`) is rejected, since the codec
takes out only a raw sfnt, while the submission asks a user agent to decompress (§2.3). Of 367 real
EOT files from npm packages the validator accepts 247 and rejects 120, all of them by this rule. The
enclosed font gets the check the codec makes on unpacking, where `SfntReader.validate` parses its
table directory: the validator parses it with the same `SfntTableDirectory`, which checks the size
of the sfnt header, its version and that the table records fit.

`EotPacker.unpack()` keeps its own checks as they were. Every source it unpacks has passed the
validator first.

What is deliberately not checked, with the reasons, is in the class comment of `EotFontValidator`.

## The sfnt validator

`SfntFontValidator` (`validator/sfnt/`, a singleton in the container) reads the whole file and
checks it, or takes from `WoffFontValidator` (above) the bytes of the sfnt a WOFF carries, and
checks them against the Microsoft OpenType specification 1.9.1 and, for what it governs, Apple's
TrueType Reference Manual: the table directory ("Table Directory"), the tables a font must have
("Required Tables"), and the fields of each table by its own section. Which fields of which tables
it reads is in the class comment of `SfntFontValidator`. `FontValidatorResolver` gives it out for a
TTF and an OTF source alike, and its answer reaches the caller the way the SVG one does: as the
cause of `FontConvertorError`, before the engine is called. The engine's TTF and OTF output is not
checked. The validator exists because the engine does not refuse a broken sfnt: of 104 variants of
the fixtures, each broken in one place, fontforge 20230101 converted 79 with exit 0, 9 of them
losing glyphs or outlines, and crashed on 8 with SIGSEGV
([#614](https://github.com/yuldashevsardor/telegram-bot/issues/614)).
`ttf → eot` does not reach the engine at all: `EotPacker.pack` reads `OS/2`, `head` and `name` and
packs whatever else the font holds.

It answers with a subclass of `InvalidSfntFont` (`sfnt-font-validator.errors.ts`): `NotSfnt` for a
file shorter than the 12-byte header or of a version outside `SFNT_VERSIONS`, `BrokenSfnt` for the
first broken rule. The order in which the rules are checked is in the comment of `validateBytes()`.
A file that cannot be read fails with `ReadFailed` of `FileHelper`, not with an answer about the
font. Every answer names the source in `path` of its payload, the WOFF file for the sfnt a WOFF
carries. Nothing in the answers is cut: the only text from the file they quote is a table tag, four
bytes long.

The rules are `SfntRule` in `sfnt-font-validator.types.ts`, each with its section. Three of them
are ours, not the standard's, and the text of each says why: a collection is rejected (see
"Signatures"); so is a font with a `CFF2` table, which the standard allows but fontforge 20230101
does not open (exit 1, "not in a known format"); and so is a `cmap` without subtables, of which the
standard sets no count. Where the two references differ, the rules follow the one that governs the
outlines present, with two exceptions, the last two items:

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
short with "Flag count is wrong". A composite glyph, of a negative `numberOfContours`, needs only
its header: the specification says -1 "should be used", and the engine reads -2 and -32768 as a
composite glyph too. Its components are not read, although the engine loses the outline of a
composite glyph cut inside a component or whose component points past `numGlyphs`, at the glyph
itself or around a cycle. None of the 297 real fonts with TrueType outlines measured breaks a
`glyf` rule.

The rules on `cmap`, `name`, `OS/2` and `post` check where the records point, not what lies there:
neither the content of a `cmap` subtable past its format and length, nor the text of a `name`
string, nor the glyph names of `post` 2.0 and 2.5 past their index. Every break they catch the
engine either converts keeping every glyph, some of them losing content, or crashes on
([#683](https://github.com/yuldashevsardor/telegram-bot/issues/683),
[#752](https://github.com/yuldashevsardor/telegram-bot/issues/752)): a `cmap` without subtables, or
whose every subtable offset points into its header and records or past where the fields of a
subtable up to its length fit, loses the encoding, with "Could not find any valid encoding tables";
a `name` with 60000 records gives "Invalid mac encoding 65535"; a `name` string past the table
crashed fontforge with SIGSEGV in every conversion in 7 of the 14 variants measured and put foreign
bytes into the full name in 2; a `post` 2.0 cut to its 32-byte header renames 399 glyphs of the
TrueType fixture, those without an encoding, to `glyphN`; an undefined format over the Unicode
subtable of the fixture leaves 225 of its 893 encoded glyphs, those of the Macintosh one. Some
breaks the rules follow the standard on, not the engine: `name` records that run into the string
storage convert with nothing lost, and so does a `cmap` subtable whose length runs past `cmap`, up
to 65535 for format 4, or a `cmap` whose one record points 2 bytes into its header while another
Unicode record holds; pointing at 0 or 4, one such record already loses the encoding. An empty
`name` string is not held to the table: it has no byte to read, and the engine converts it at any
offset. None of these rules rejects a font of the 242 in the macOS system font folders, which the
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
  and its table directory, every `loca` offset and every glyph of `glyf` are walked on the event
  loop, as they are for the sfnt a WOFF carries. An EOT source is read whole too, and its header is
  walked on the event loop. A WOFF2 source reads `headLength` bytes. Only the sfnt walk was
  measured: `validateBytes()` takes 27 ms on `Arial Unicode.ttf`, 22 MB and 50377 glyphs, which the
  engine converts in 2.5 s
  ([#684](https://github.com/yuldashevsardor/telegram-bot/issues/684)).
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
