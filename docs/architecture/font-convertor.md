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
    the file matches the format signature; the result path does not exist
  → FontForge.convert(): fontforge -c '<script>' SRC DIST through ProcessHelper.run
```

What bypasses the engine is the format itself, not a pair: there is neither `Extension.EOT` in
`FontForge.supportedExtensions` nor `.eot` among the `fontforge` arguments (the engine does not
read this envelope, and on writing silently corrupts the file — [invariant](./invariants.md)).
`EotPacker` takes the envelope off and puts it on, so when an EOT pair needs the engine, the
engine reads or writes a plain sfnt, never the envelope:

```
ttf → eot                    EotPacker.pack(SRC, DIST)
{otf,woff,woff2,svg} → eot   FontForge.convert(SRC, DIST.ttf) → EotPacker.pack(DIST.ttf, DIST)
eot → ttf                    EotPacker.unpack(SRC, DIST)
eot → {otf,woff,woff2,svg}   EotPacker.unpack(SRC, DIST.ttf) → FontForge.convert(DIST.ttf, DIST)
```

The intermediate sfnt lies next to the result (`<result>.ttf`: the result name is unique in its
directory, so the derived one is unique too) and is removed after a success and after a failure
alike — but not in `finally`: there `RemoveFailed` would displace the original error, and the real
reason for the failure would not survive even in `cause`. Precedence is the opposite of
`finally`'s: a removal error surfaces only if nothing failed before it
(`TwoStepEotConvertor.throughIntermediate()`).

The `Convertor` classes of the EOT pairs inherit through two parents, kept apart so that no pair
class gets what it does not need: `EotConvertor` is the constructor for the pairs the codec alone
is enough for (`ttf ↔ eot`), `TwoStepEotConvertor` is the constructor, the intermediate path and
the removal for the other eight, whose bodies live in `ToEotConvertor` and `FromEotConvertor`.
Those eight classes are empty except for declaring the missing extension; `TtfToEot` and
`EotToTtf` declare both and keep `convert()` to themselves — in `EotConvertor` there is nowhere
for the body to move up to.

`EotPacker` (`eot-packer/`) is the only place where the domain parses the content of a font rather
than just its first bytes. The EOT header duplicates the metadata of the enclosed font, and
`SfntReader` takes it from the `OS/2`, `head` and `name` tables (four names, UTF-16LE in the
envelope). It takes the slant from `OS/2.fsSelection`, not from `head.macStyle`, which duplicates
it: `ttf2eot` does the same, and in `macStyle` the slant is bit 1, which in `fsSelection` means
something else. Names are read from the Windows platform, failing that from Unicode, then from
Macintosh, and there only with `encodingId 0`: only that one is single-byte MacRoman, the other
records hold national encodings. Within a platform English is preferred (`0x0409` on Windows, `0`
on the others) — a font does not guarantee the order of its records. The names are informational,
so neither a missing record, nor a missing `name` table, nor a string past the declared end of the
table or past the end of the file rejects the font: the matching envelope field stays empty.

The header layout and the set of versions — which one is written, which are read — are laid out in
`eot-packer.ts` itself; a compressed (`TTEMBED_TTCOMPRESSED`) or encrypted
(`TTEMBED_XORENCRYPTDATA`) payload the codec rejects with an explicit `UnsupportedEotFlags` error
instead of trying to parse it.

The engine is launched only through `ProcessHelper.run(file, args)`, a wrapper over
`child_process.execFile`: the arguments go as an array, past `/bin/sh`
([invariant](./invariants.md)). Building the command as a string and calling `exec` is not allowed
here — the file name comes from the user. The same technique removes the second level of
interpretation, Python's: the paths are passed as arguments and read by the script from
`sys.argv`, not substituted into the script text.

The source format is checked twice: by the extension of the name and by the signature — the first
`headLength` bytes of the file (`FontSignatureMatcher`, a singleton in the container). The name is
set by whoever sent the file, so the extension alone cannot be trusted. The code recognises the
signatures itself, without an external tool: `file --mime-type` gives no usable answer for three
of the six formats (none at all for EOT, and for TTF and OTF it also depends on the libmagic
version).

The signature does not tell everything apart: TTF and OTF share the sfnt container, and the sfnt
version names the outline type, not the extension, and outlines of either type are legal under
both names. So both extensions accept the whole set of sfnt signatures — the signature confirms the
container, and the extension still picks the conversion pair.

One sfnt version the set does not accept: the `ttcf` collection. It holds several fonts, and which
of them to take is not the domain's call — the engine would silently take the first, while the EOT
envelope would reject the whole file, and one and the same name would behave differently from pair
to pair. Under the names `.ttf` and `.otf` a collection is rejected here, before the chosen pair
does any work, the same way for every pair.

This does not make the version check in `SfntReader` redundant: the signature sees only the source
under its own extension, while two more files it never saw pass through the codec — the
intermediate sfnt from the engine on packing and the envelope content on unpacking. The checks
differ — the first bytes of the head against parsing the table directory — but they share one set
of versions: `SFNT_VERSIONS` in `font-convertor/sfnt-version.ts`, from which the signature takes
bytes and the codec reads the same values as numbers. The set must not become two lists: a
divergence breaks behaviour rather than the build — a version known only to the signature reaches
the codec and fails there with `InvalidSfnt`, one known only to the codec does not get past the
input.

The signatures differ in strictness too: the SVG one only tells markup from binary junk — it says
"this is markup", not "this is a font". That is why it does not look for the root tag: a doctype or
a comment may legally stand before it, and enumerating those prologues would mean extending the
signature for each new one. Instead of an enumeration the signature is described by a byte class:
`<` is followed by a letter of the root tag or by the `!` of a doctype or a comment, and then by
text. A processing instruction is not in the class: only the separate `<?xml` signature lets it
through — an enumeration, not a class, so what passes is the XML declaration and an instruction
whose target starts the same way. The text in the class is not decoration: a markup start alone is
not enough, because the EOT header opens with the file size, and in the fixture its low bytes
form `<m` — a binary head would pass as a document.

Not every offset is fixed: for the binary formats it is rigid from the start of the file, while
SVG markup may legally be preceded by a prefix — each signature declares which one itself, and the
bytes are counted from its end. Before `<?xml` only a UTF-8 BOM: the XML declaration has to open
the document, and the engine does not open a file indented before it. Before any other markup, a
BOM and leading whitespace; for the same reason `?` is not in the markup-start class, otherwise an
indent would become allowed before the declaration too. The indent has a limit, otherwise the file
head would grow with it, and the limit is counted past the BOM, not together with it: a shared
budget would mean that an invisible BOM shortens the allowed indent. The maximum prefix length is
also built into `headLength` — skipped bytes shorten the useful part of the head.

The pair table in `ConvertorFactory` is the only source of what the domain can do: the convertor is
picked from it, and `getSupportedExtensions()` is derived from it, which the welcome promises the
user ([`i18n.md`](./i18n.md)). A format declared in `Extension` but absent from the table does not
count as supported.

Known:

- Temporary files are not deleted (issue
  [#37](https://github.com/yuldashevsardor/telegram-bot/issues/37)).
- `/font_generator` converts the fixed `test/fixtures/fonts/test-font.woff` into
  EOT/OTF/TTF/WOFF2 and answers with the **path** to the file as text; the file itself is not
  sent. A caught conversion error is written at `error` level through `Logger`
  ([`logging.md`](./logging.md)). The command is for debugging and does not go to production
  ([overview](./README.md)), so the input from the `test/` directory stays as it is.
- The EOT envelope is not read through: the names are parsed, then the font is taken as the tail
  of the file by `FontDataSize`. The bytes between the parsed header and the font are not checked,
  in any version: only a header running past the font start is rejected. In version `0x00020002`
  the tail (a signature, embedded EUDC) lies there.
- An envelope built by `EotPacker` repeats the output of `ttf2eot` byte for byte, except for
  `fsType`: `ttf2eot` always writes zero, declaring any font free to install, while we carry
  `OS/2.fsType` over as is, following the specification. The byte-for-byte comparison test with
  the fixture rests on this.
