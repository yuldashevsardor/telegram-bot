# Font conversion

```
FontConvertor.convert({ originPath, extension })
  → source extension ≠ target one, otherwise FontConvertorError
  → name: 15 random characters + extension, directory tempDir/YYYY/M/D
    (FileHelper.createDirectoriesByDate(): tempDir exists, is readable, is writable and is a
    directory)
  → ConvertorFactory.get(from, to): from the pair table, one class per pair,
    convertor/<from>/<from>-to-<to>.ts
  → Convertor.validate(): the source exists and is readable, its extension matches, the start of
    the file matches the format signature (an SVG source passes SvgFontValidator instead); the
    result path does not exist
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

`EotPacker` (`eot-packer/`) is one of the two places on the conversion path where the domain parses
the content of a font, not just its first bytes; the other is the SVG validator below. The EOT
header duplicates the metadata of the enclosed font. `SfntReader` takes it from the `OS/2`, `head`
and `name` tables. The envelope holds four names, in UTF-16LE. The slant is taken from
`OS/2.fsSelection`, not from `head.macStyle`, which duplicates it. `ttf2eot` does the same. Besides,
in `macStyle` the slant is bit 1, and bit 1 of `fsSelection` means something else.

Names are read from the Windows platform, failing that from Unicode, then from Macintosh. On
Macintosh only `encodingId 0` is read: only that one is single-byte MacRoman, the other records hold
national encodings. Within a platform English is preferred (`0x0409` on Windows, `0` on the others),
because a font does not guarantee the order of its records.

The names are informational, so a missing name never rejects the font: the matching envelope field
stays empty. That holds for a missing record, a missing `name` table, and a string past the declared
end of the table or past the end of the file.

`eot-packer.ts` itself lays out the header and the versions: which one is written, which are read. A
compressed (`TTEMBED_TTCOMPRESSED`) or encrypted (`TTEMBED_XORENCRYPTDATA`) payload is rejected with
an explicit `UnsupportedEotFlags` error; the codec does not try to parse it.

## Running the engine

The engine is launched only through `ProcessHelper.run(file, args)`, a wrapper over
`child_process.execFile` ([invariant](./invariants.md)). The arguments go as an array, past
`/bin/sh`. Building the command as a string and calling `exec` is not allowed here, because the file
name comes from the user. The same technique removes the second level of interpretation, Python's:
the script reads the paths passed as arguments from `sys.argv`, they are not substituted into the
script text.

## Signatures

The source format is checked twice: by the extension of the name and by the content. For five
formats the content is the signature: the first `headLength` bytes of the file
(`FontSignatureMatcher`, a singleton in the container). SVG has no signature: its first bytes could
say at most "this is markup", not "this is a font", so the SVG validator below reads the whole
document instead. The name is set by whoever sent the file, so the extension alone cannot be
trusted. The code recognises the signatures itself, without an external tool. `file --mime-type`
gives no usable answer for three of the five formats: none at all for EOT, and for TTF and OTF the
answer also depends on the libmagic version.

The signature does not tell TTF from OTF. Both use the sfnt container, and the sfnt version names
the outline type, not the extension. Outlines of either type are legal under both names. So both
extensions accept the whole set of sfnt signatures: the signature confirms the container, and the
extension still picks the conversion pair.

The set leaves out one sfnt version: the `ttcf` collection. A collection holds several fonts, and
which of them to take is not the domain's call. The engine would silently take the first, while the
EOT envelope would reject the whole file, so one and the same file would behave differently from
pair to pair. A collection named `.ttf` or `.otf` is therefore rejected here, the same way for every
pair, before the chosen pair does any work.

This does not make the version check in `SfntReader` redundant. The signature sees only the source
under its own extension. Two more files pass through the codec that the signature never saw: the
intermediate sfnt from the engine on packing, and the envelope content on unpacking. The two checks
differ: the signature compares the first bytes of the head, the codec parses the table directory.
But they share one set of versions, `SFNT_VERSIONS` in `font-convertor/sfnt-version.ts`. The
signature takes bytes from it, the codec reads the same values as numbers. The set must not become
two lists, because a divergence breaks behaviour rather than the build. A version known only to the
signature reaches the codec and fails there with `InvalidSfnt`. A version known only to the codec
does not get past the input.

Every offset is counted from the start of the file. A prefix is not skipped: a shifted head would
turn the check into a search for the marker anywhere.

## The SVG validator

`SvgFontValidator` (`svg-validator/`, a singleton in the container) reads the whole file and checks
it against W3C SVG 1.1 Second Edition, chapter 20 "Fonts". SVG 2 removed SVG fonts, so 1.1 is the
reference. `Convertor.validate()` calls it for an SVG source in place of a signature, and its
answer leaves the pair unchanged: `FontConvertor` wraps it in `FontConvertorError` as the cause,
like any failure of the pair. A rejected source never reaches the engine. The engine's SVG output
is not checked: the validator sees only the source.

It answers with a subclass of `InvalidSvgFont`, in this order: `NotXml`, `NotSvg`, `NoFont`,
`BrokenFont`. The order holds because the answers are given after one full pass over the document:
a file that breaks off halfway is "not XML" even if its well-formed head already broke a font rule.
Of several broken rules, `BrokenFont` names the first the pass met.

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
  the document. `font-face` and `glyph` count only as direct children of `font` in the SVG
  namespace, and only unprefixed attributes are attributes of these elements. The rules are
  `FontRule` in `svg-font-validator.types.ts`; the text of each names its section. Two of them are
  ours, not the specification's, and say so: `units-per-em` is required (the specification defaults
  it to 1000, but fontforge does not open a font without it), and a font needs a `glyph` (the
  specification allows none, but fontforge turns such a font into an empty one). The path data of
  `d` is not checked yet ([#611](https://github.com/yuldashevsardor/telegram-bot/issues/611)).

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
namespace and the local name of a `NotSvg` root and the attribute value of a `BrokenFont` each to
`MAX_QUOTED_LENGTH`. A cut piece ends with `…`, which makes it one unit longer than an uncut piece
can be: that, not the text, tells it from a piece that ends with `…` itself. This holds for every
piece of the payload and of the `NotXml` and `NotSvg` messages. The `BrokenFont` message escapes the
kept value with `JSON.stringify`, which can make it longer, so there the `…` stands outside the
quotes, where the escaped value cannot reach. The payload also keeps the length before the cut:
`valueLength` of the value, which, like the length of `value`, tells a cut value, and `rootLength`
of the whole root, which does not say which of its two pieces was cut.

## The pair table

The pair table in `ConvertorFactory` is the only source of what the domain can do. The convertor is
picked from it, and `getSupportedExtensions()` is derived from it. The welcome promises that list to
the user ([`i18n.md`](./i18n.md)). A format declared in `Extension` but absent from the table does
not count as supported.

## Known

- Temporary files are not deleted (issue
  [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).
- `/font_generator` converts the fixed `test/fixtures/fonts/test-font.woff` into
  EOT/OTF/TTF/WOFF2. It answers with the **path** to the file as text; the file itself is not
  sent. A caught conversion error is written at `error` level through `Logger`
  ([`logging.md`](./logging.md)). The command is for debugging and does not go to production
  ([overview](./README.md)), so its input from the `test/` directory stays as it is.
- The EOT envelope is not read through. The names are parsed, then the font is taken as the tail
  of the file by `FontDataSize`. The bytes between the parsed header and the font are not
  checked, in any version: only a header running past the font start is rejected. In version
  `0x00020002` the tail (a signature, embedded EUDC) lies there.
- An envelope built by `EotPacker` repeats the output of `ttf2eot` byte for byte, except for
  `fsType`. `ttf2eot` always writes zero there, declaring any font free to install. We carry
  `OS/2.fsType` over as is, following the specification. The byte-for-byte comparison test with
  the fixture rests on this.
