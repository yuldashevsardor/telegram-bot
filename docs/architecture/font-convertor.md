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

`EotPacker` (`eot-packer/`) is the only place where the domain parses the content of a font, not
just its first bytes. The EOT header duplicates the metadata of the enclosed font. `SfntReader`
takes it from the `OS/2`, `head` and `name` tables. The envelope holds four names, in UTF-16LE. The
slant is taken from `OS/2.fsSelection`, not from `head.macStyle`, which duplicates it. `ttf2eot`
does the same. Besides, in `macStyle` the slant is bit 1, and bit 1 of `fsSelection` means something
else.

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

The source format is checked twice: by the extension of the name and by the signature. The signature
is the first `headLength` bytes of the file (`FontSignatureMatcher`, a singleton in the container).
The name is set by whoever sent the file, so the extension alone cannot be trusted. The code
recognises the signatures itself, without an external tool. `file --mime-type` gives no usable
answer for three of the six formats: none at all for EOT, and for TTF and OTF the answer also
depends on the libmagic version.

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

The signatures differ in strictness too. The SVG one only tells markup from binary junk: it says
"this is markup", not "this is a font". That is why it does not look for the root tag. A doctype or
a comment may legally stand before the root tag, and enumerating those prologues would mean
extending the signature for each new one. Instead the signature is described by a byte class: `<`,
then a letter of the root tag or the `!` of a doctype or a comment, then text.

A processing instruction is not in the class. Only the separate `<?xml` signature lets one through,
and that signature is an enumeration, not a class. So what passes is the XML declaration and an
instruction whose target starts the same way. The text in the class is not decoration: a markup
start alone is not enough. The EOT header opens with the file size, and in the fixture its low bytes
form `<m`. Without the text a binary head would pass as a document.

Not every offset is fixed. For the binary formats the offset is rigid from the start of the file.
SVG markup may legally be preceded by a prefix: each signature declares which one, and the bytes are
counted from the prefix's end.

- Before `<?xml` only a UTF-8 BOM is allowed. The XML declaration has to open the document, and
  the engine does not open a file indented before it.
- Before any other markup, a BOM and leading whitespace are allowed. For the same reason `?` is
  not in the markup-start class: otherwise an indent would become allowed before the declaration
  too.
- The indent has a limit, otherwise the file head would grow with it. The limit is counted past
  the BOM, not together with it: with a shared budget an invisible BOM would shorten the allowed
  indent.
- The maximum prefix length is built into `headLength`, because skipped bytes shorten the useful
  part of the head.

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
