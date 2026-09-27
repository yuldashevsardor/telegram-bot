# Outbox

Outgoing Bot API calls as rows in PostgreSQL, so that any node can send them, the order inside a
chat holds across nodes, and a node that dies loses nothing. The plan and the decisions are in the
epic, [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618). Built so far: the tables
and `OutboxStore` (`telegram/outbox/store/outbox-store.ts`), which enqueues, claims and marks
done. Nothing calls the store yet: outgoing calls still go through the in-memory queue
([`outbound-queue.md`](./outbound-queue.md)).

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

## Code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").
