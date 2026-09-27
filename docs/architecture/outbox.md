# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
and any node sends them (the plan is epic
[#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)). Nothing calls the directory
yet: so far it holds the payload codec alone.

## The payload rule

A row outlives the process that wrote it and is sent by whichever node claims it, so only what
another node can rebuild enters the outbox. `serialize(method, payload)`
(`payload-codec/payload-codec.ts`) walks the payload deeply, the `media[]` of `sendMediaGroup`
included:

- plain JSON is copied as is. So is any other value (`undefined`, a `Date`): the row goes through
  JSON the same way grammY sends a payload;
- a file made by `queueFile(path, filename?)` becomes the marker
  `{ "$queuedFile": { "path", "filename" } }`, and `deserialize()` rebuilds it through
  `queueFile()`; a marker without a string `path`, or with a `filename` that is not a string,
  throws `InvalidFileMarker`. The marker is the stored format: a change of its key leaves the
  rows already written unreadable;
- any other `InputFile` throws `UnsupportedInputFile` with the method in the message and the
  payload: a `Buffer`, a stream or a supplier function lives only in the memory of this process.

grammY keeps the source of an `InputFile` private, so `queueFile()` remembers the path itself, in
a `WeakMap` keyed by the file. That is why a path passed to `new InputFile()` is rejected too: the
codec cannot read it.

The node that sends the row reads the file at the stored path. The rules this puts on the path are
in [`invariants.md`](./invariants.md), "The outbox".
