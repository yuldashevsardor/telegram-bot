# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
any node sends them, the order inside a chat holds across nodes, and a node that dies loses
nothing (the plan is epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)).
Nothing calls the directory yet: so far it holds the tables with `OutboxStore`
(`store/outbox-store.ts`), which pushes, pulls and marks done, and the payload codec.

## Tables

One migration, `1790546834232_telegram-outbox-tables.ts`, creates the three tables with every
column the outbox needs, including those only later stages use (`attempts`, `locked_until`,
`lock_token`, `telegram_bot_limits`). The columns and what they mean are in its `createTable`
calls and `comment`s. There are no indexes besides the primary keys yet: they will be picked once
the queries of every stage are settled.

The database does not check the values of `status` and `state`: the store writes them only
through the `OutboxStatus` and `OutboxChatState` enums (`store/outbox-store.types.ts`). Of these,
nothing sets `failed`, `skipped` and `blocked` yet, and `done` rows are not deleted yet.
`telegram_bot_limits` holds one row, `id = 1`, inserted by the migration; nothing but the code
keeps it single.

The **head** of a chat is its first message by `id` among the active statuses (`pending`,
`processing`, `failed`). The priority of a chat is the priority of its head, read from the head
itself when needed: the chat row keeps no copy.

## Chat states

| state | who sets it |
|---|---|
| `idle` | `push` of a new chat, for the moment before its messages are inserted; `markAsDone` of the last active message |
| `ready` | `push` into an `idle` chat; `markAsDone` when a message is left |
| `processing` | `pull` |

## The chat lock

The chat row is the lock of its chat. `push` and `markAsDone` lock the rows of their chats first
and read what their change depends on — the chat state, the next head — in a later statement of
the same transaction ([invariant](./invariants.md)). Under `read committed` every statement reads
a fresh snapshot, so a statement that runs after the lock sees what the previous holder of the lock
committed. A single statement reads its snapshot before it waits for the lock. A completion written
that way leaves a chat `idle` with a message pushed meanwhile: a message that is never sent. A push
written that way takes its ids before the lock, and two pushes of one chat can commit in the order
opposite to their ids: the later message is sent first.

So a push and a completion of one chat are serialized in either order: the one that locks second
sees what the first committed. `test/telegram/outbox/outbox-store.spec.ts` lines the calls up
behind a lock held by a third client and pins both orders, and the ids of a push taken after its
lock.

`pull` is the exception: it locks and reads the head in one statement, see below.

## Push

`push()` is `pushBatch()` of one message. The batch is a transaction:

1. the chats of the batch that have no row yet are inserted `idle` (`on conflict do nothing`);
2. every chat of the batch is locked, `select … for update` in `chat_id` order, so two batches
   lock the chats they share in the same order;
3. the messages go in as one `jsonb` array and are inserted `order by` their position in it, so
   the ids grow in the order of the input;
4. every `idle` chat of the batch becomes `ready`; a chat in any other state already has an older
   head.

## Pull

`pull(limit)` is one statement, atomic without a transaction:

1. up to `limit` `ready` chats with the head of each (`join lateral`), by the priority of the head
   and then by `next_send_at`, `for update of chats skip locked`: a chat another puller holds is
   skipped, not waited for;
2. the head goes to `processing`, but only if it is still `pending`;
3. the chats whose head was pulled go to `processing`, and `next_send_at` moves to `now()`.

Step 3 is what serves the chats of one priority in turn: a chat just served goes behind the chats
that waited. Only one head per chat is taken, and a `processing` chat is not `ready`, so a chat
never has two messages in `processing`.

Step 1 reads the head from the snapshot of the statement, taken before the lock. A chat completed
and made `ready` again after the snapshot still passes the lock (the lock rereads the newest row
version), while the head read with it is the old one, already `done` by then. The check of step 2
turns that head away: the chat is left `ready` for the next pull instead of sending the head twice.

The pull does not look at the limits or the pause yet: `next_send_at` only orders the chats.

## Mark as done

`markAsDone(messageId, response)`, where `messageId` is `telegram_outbox.id`, is a transaction:

1. lock the chat row of the message;
2. the message goes to `done` with the response and `finished_at`, only from `processing`;
   otherwise, a missing message included, the method returns `false` and changes nothing;
3. read the next head of the chat;
4. the chat goes to `ready` if there is one, or to `idle`.

Every update of the store sets `updated_at = now()` itself; there is no trigger.

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
