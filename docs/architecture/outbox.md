# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
and any node sends them (the plan is epic
[#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)). Nothing calls the directory
yet: so far it holds the payload codec alone.

## The payload rule

A row outlives the process that wrote it and is sent by whichever node claims it, so only what
another node can rebuild enters the outbox. `serialize(method, payload)`
(`payload-codec/payload-codec.ts`) walks the payload the way `JSON.stringify` walks it when the
row is written, so no part of the payload reaches the row unchecked:

- `toJSON()` is called where JSON calls it, with the same key, and what it returns is walked in
  turn: a `Date` comes out as its string. Any other object — an array, a plain object, a class
  instance such as grammY's `InlineKeyboard`, an object without a prototype — is copied by its own
  enumerable keys. A value that is not an object (`undefined`) is kept as is and left to JSON;
- a `PathFile` (`new PathFile(path, filename?)`, `telegram/path-file/path-file.ts`, a subclass of
  `InputFile`) is taken before its `toJSON()` and becomes the marker
  `{ "$pathFile": { "path", "filename" } }`; `deserialize()` rebuilds it as a `PathFile`. The
  marker is the stored format: a change of its key leaves the rows already written unreadable. A
  marker `serialize()` would not write throws `InvalidFileMarker`: a key beside `$pathFile`, a
  field other than `path` and `filename`, a `path` that is not an absolute path string, a
  `filename` that is neither a string nor absent;
- any other `InputFile` throws `UnsupportedInputFile`: a `Buffer`, a stream or a supplier function
  lives only in the memory of this process. It is taken before its `toJSON()` too, so a file
  grammY has already sent, whose `toJSON()` grammY replaced with one returning `attach://<id>`,
  is rejected rather than stored as that string;
- an object that already carries the marker key throws `ReservedFileKey`: `deserialize()` would
  read it as a file;
- a string or a key with U+0000 throws `NulCharacter`: PostgreSQL does not accept it in `jsonb`;
- a payload that refers back to itself throws `CyclicPayload`.

An error of `serialize()` names the method and where the value sits in the payload
(`media.1.thumbnail`), in the message and in `payload`.

grammY keeps the source of an `InputFile` private, so `PathFile` keeps the path in a public
field of its own. That is why a path passed to `new InputFile()` is rejected too: the codec cannot
read it. `PathFile` itself rejects a relative path with `RelativeFilePath`.

The node that sends the row reads the file at the stored path. The rules this puts on the path are
in [`invariants.md`](./invariants.md), "The outbox".
