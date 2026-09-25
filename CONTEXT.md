# Font conversion

The service moves font files between formats. It aims to cover as many format pairs as possible, including formats that have fallen out of use. Everything else in the repository (Telegram, users, the database) serves the intake and the delivery of fonts and is not part of this domain.

The glossary describes the subject area, not the layout of the code: class names, DI, pipelines and Telegram live in `docs/architecture/`.

## Vocabulary

### Core notions

**Font conversion**:
The one and only task of the service: moving a font from one format into another. Its value is measured by the width of the pair matrix: how many formats it can move from, into how many.
_Avoid_: font-format conservation, format preservation, saving formats. This name was rejected, and that is a decision, not a matter of style. None of the three says that the font comes out in another format: they name keeping a format alive, and `saving` reads as writing the file to disk.

**Conversion**:
A single move of one font from a source format into a target format, producing a new file. It is always one step. The source and the target format cannot be the same. If the move goes through an intermediate format, that format is invisible from the outside and does not count as a conversion result.
_Avoid_: generation, export, transformation.

**Conversion pair**:
An ordered pair "source format → target format". It is the unit of support in this domain: the service supports specific pairs, not a format as such. The matrix is currently complete for the six supported formats: 30 pairs.
_Avoid_: direction, route.

**Conversion engine**:
An external tool that performs the move between formats itself. The domain does not move outlines on its own: it picks the pair, checks the input and hands the work to the engine. What the engine can do sets the range of reachable pairs but does not exhaust it. The domain handles the envelope itself, so a pair that needs the engine for only part of the way is still reachable.
_Avoid_: convertor. That is the name of a part of the domain, not of the engine.

### Formats

**Format**:
A form in which a font is represented, and between which the service moves it: WOFF, WOFF2, OTF, TTF, EOT, SVG.
_Avoid_: extension, file type, MIME type.

**Supported format**:
A format taking part in at least one conversion pair. Currently all six formats of the domain are supported. Declaring a format in a list does not make it supported.
_Avoid_: available format, known format.

**Envelope**:
A format that does not describe outlines itself but carries a font of another format inside, together with a copy of its metadata. The domain has one such format, EOT. Inside it lies an untouched sfnt, and its header duplicates the names, the weight and the slant of the enclosed font. The domain splits a pair with an envelope into two parts: the work on the envelope itself and the move of the enclosed font.
_Avoid_: wrapper, container. Container is the name of the format shared by TTF and OTF, and that is a different thing.

**Extension**:
The suffix of a file name. It is the first of the two signs by which the domain determines the format of a font. The extension is a statement about the name of the file, not about its bytes, and whoever sent the file sets it. So the extension alone is not enough for the domain: it is checked against the format signature.
_Avoid_: format. An extension is a way to learn the format, not the format itself.

**Format signature**:
Known bytes in the head of a font by which the format is recognised in the file itself rather than in its name. They do not necessarily start at the first byte. In EOT the marker lies at a fixed offset inside the header. In SVG a prefix before the markup is legal, so the bytes are counted from the end of that prefix. The signature is the second sign of the format: the extension and the signature have to agree, otherwise the font is not admitted to conversion. A signature does not tell every pair of formats apart, and not with the same strictness. TTF and OTF lie in a shared container and are indistinguishable by content. In SVG the signature only tells markup from binary junk. How the check works is in `docs/architecture/font-convertor.md`.
_Avoid_: MIME type, magic bytes, content type.

### Files

**Font**:
A file in one of the formats. For this domain it is almost opaque. The domain reads the head of the file to check the format against the signature, then hands the file to the engine and does not look inside. The exception is the envelope: to assemble it or to take it apart, the domain reads the metadata of the enclosed font. Even there it only copies the metadata and does not parse outlines.
_Avoid_: typeface. That is a typography term for the design; here the subject is the file.

**Source font**:
A font submitted for conversion. The domain only reads it: it does not change it, rename it or delete it.
_Avoid_: original, input file.

**Conversion result**:
A new file in the target format, created by a conversion. Its name is not related to the name of the source font. A conversion never overwrites an existing file. When the result stops being needed is not for the domain to decide.
_Avoid_: generated font, output file.

### Outside the model

Typography terms that come up by themselves in a conversation about fonts but that this domain does not have. Needing one of them means extending the model, not clarifying the wording.

**Family**:
Not part of the domain. The service copies the family name from the font into the envelope but does not read it as a name: it does not search, compare or select by family.

**Style**:
Not part of the domain. The service copies the weight and the slant from the font into the envelope as the same bytes, but it does not tell styles apart and cannot select a font by one.

**Glyphs and metrics**:
Not part of the domain. From a font the service reads the format signature and the metadata for the envelope but does not parse the outlines, so it can neither list the glyphs nor compare them before and after a conversion. The domain currently neither expresses nor checks whether glyphs and metrics survive a conversion.
