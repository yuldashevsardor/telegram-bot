# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
any node sends them, the order inside a chat holds across nodes, and a node that dies loses
nothing (the plan is epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)).
Nothing calls the directory yet: so far it holds the tables with `OutboxStore`
(`store/outbox-store.ts`), which enqueues, claims and marks done, and the payload codec.

## Tables

One migration, `1790546834232_telegram-outbox-tables.ts`, creates the three tables with every
column and index the outbox needs, including those only later stages use (`attempts`,
`locked_until`, `lock_token`, `telegram_bot_limits`). The columns, the allowed values of `status`
and `state` and what they mean are in its `createTable` calls and `comment`s. Of the statuses and
states, nothing sets `failed`, `skipped` and `blocked` yet, and `done` rows are not deleted yet.

The **head** of a chat is its first message by `id` among the active statuses (`pending`,
`processing`, `failed`). The partial index `telegram_outbox_head_idx` over `(chat_id, id)` has the
same predicate, and the queries of the store repeat it word for word: a query whose condition does
not imply the predicate cannot use the index.

The hot tables get their own `fillfactor` and autovacuum thresholds in the migration (how a
migration sets them is in [`storage.md`](./storage.md), "Migrations"). The numbers are a starting
point, not a measurement.

## Chat states

| state | who sets it |
|---|---|
| `idle` | `enqueue` of a new chat, for the moment before its messages are inserted; `markDone` of the last active message |
| `ready` | `enqueue` into an `idle` chat; `markDone` when a message is left |
| `processing` | `claim` |

`head_priority` is the priority of the head, not of the latest message: `enqueue` sets it only
when the chat was `idle`, and `markDone` sets it to the priority of the next head, or `null` when
there is none.

## The chat lock

The chat row is the lock of its chat. `enqueue` and `markDone` lock the rows of their chats first
and read what their change depends on — the chat state, the next head — in a later statement of
the same transaction ([invariant](./invariants.md)). Under `read committed` every statement reads
a fresh snapshot, so a statement that runs after the lock sees what the previous holder of the lock
committed. A single statement reads its snapshot before it waits for the lock. A completion written
that way leaves a chat `idle` with a message enqueued meanwhile: a message that is never sent. An
enqueue written that way takes its ids before the lock, and two enqueues of one chat can commit in
the order opposite to their ids: the later message is sent first.

So an enqueue and a completion of one chat are serialized in either order: the one that locks
second sees what the first committed. `test/telegram/outbox/outbox-store.spec.ts` lines the calls
up behind a lock held by a third client and pins both orders, and the ids of an enqueue taken after
its lock.

`claim` is the exception: it locks and reads the head in one statement, see below.

## Enqueue

`enqueue()` is `enqueueBatch()` of one message. The batch is a transaction of two statements:

1. the chats of the batch are locked in `chat_id` order, so two batches lock the chats they share
   in the same order. A new chat is inserted `idle`. An existing one is locked by
   `on conflict do update … where false`: the conflicting row is locked even though the update
   never happens, and the row gets no new version;
2. the messages go in as one `jsonb` array and are inserted `order by` their position in it, so
   the ids grow in the order of the input. Every `idle` chat of the batch becomes `ready` with the
   priority of its first new message; a chat in any other state already has an older head.

## Claim

`claim(limit)` is one statement:

1. up to `limit` `ready` chats by `(head_priority, next_send_at)`, `for update skip locked`: a chat
   another claimer holds is skipped, not waited for;
2. `join lateral` the head of each chat;
3. the head goes to `processing`, but only if it is still `pending`;
4. the chats whose head was claimed go to `processing`, and `next_send_at` moves to `now()`.

Step 4 is what serves the chats of one priority in turn: a chat just served goes behind the chats
that waited. Only one head per chat is taken, and a `processing` chat is not `ready`, so a chat
never has two messages in `processing`.

Step 2 reads the head from the snapshot of the statement, taken before the lock of step 1. A chat
completed and made `ready` again after the snapshot passes step 1 (the lock rereads the newest row
version), while step 2 still sees the old head, already `done` by then. The check of step 3 turns
that head away: the chat is left `ready` for the next claim instead of sending the head twice.

The claim does not look at the limits or the pause yet: `next_send_at` only orders the chats.

## Mark done

`markDone(id, response)` is a transaction of three statements:

1. lock the chat row of the message;
2. the message goes to `done` with the response and `finished_at`, only from `processing`;
   otherwise the method returns `false` and changes nothing;
3. the chat goes to `ready` with the priority of the next head, or to `idle`.

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

## The payload rule

A row outlives the process that wrote it and is sent by whichever node claims it, so only what
another node can rebuild enters the outbox. `serialize(method, payload)`
(`payload-codec/payload-codec.ts`) walks the payload deeply, the `media[]` of `sendMediaGroup`
included:

- arrays and plain objects are copied; any other value (`undefined`, a `Date`) is kept as is: the
  row goes through JSON the same way grammY sends a payload;
- a `PathFile` (`new PathFile(path, filename?)`, `telegram/path-file.ts`, a subclass of
  `InputFile`) becomes the marker `{ "$pathFile": { "path", "filename" } }`, and `deserialize()`
  rebuilds it as a `PathFile`; a marker without a string `path`, or with a `filename` that is not
  a string, throws `InvalidFileMarker`. The marker is the stored format: a change of its key leaves
  the rows already written unreadable. An object of the payload that already carries the key
  throws `ReservedFileKey` in `serialize()`: `deserialize()` would read it as a file;
- any other `InputFile` throws `UnsupportedInputFile` with the method in the message and the
  payload: a `Buffer`, a stream or a supplier function lives only in the memory of this process.

grammY keeps the source of an `InputFile` private, so `PathFile` keeps the path in a public
field of its own. That is why a path passed to `new InputFile()` is rejected too: the codec cannot
read it.

The node that sends the row reads the file at the stored path. The rules this puts on the path are
in [`invariants.md`](./invariants.md), "The outbox".
