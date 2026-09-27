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
`locked_until`, `lock_token`, `telegram_bot_limits`). The purpose of a column is in its `comment`
there.

- `telegram_outbox` — a row per call. `id` is the order inside a chat. `status` goes `pending` →
  `processing` → `done`; `failed` and `skipped` are declared but nothing sets them yet.
- `telegram_outbox_chats` — a row per chat: `state` (`idle` / `ready` / `processing` /
  `blocked`), `next_send_at`, `head_priority`.
- `telegram_bot_limits` — exactly one row, inserted by the migration. The primary key is a
  `boolean` constrained to `true`, so a second row cannot be inserted.

The **head** of a chat is its first message by `id` among the active statuses (`pending`,
`processing`, `failed`). The partial index `telegram_outbox_head_idx` over `(chat_id, id)` has the
same predicate, and the queries of the store repeat it word for word: a query whose condition does
not imply the predicate cannot use the index.

The hot tables get their own `fillfactor` and autovacuum thresholds in the migration (how a
migration sets them is in [`storage.md`](./storage.md), "Migrations"). The numbers are a starting
point, not a measurement.

`done` rows stay in the table; nothing deletes them yet.

## Chat states

| state | meaning | who sets it |
|---|---|---|
| `idle` | no active message | `markDone` of the last active message |
| `ready` | the head is `pending` and can be claimed | `enqueue` of an idle or new chat; `markDone` when a message is left |
| `processing` | the head is claimed | `claim` |
| `blocked` | declared, nothing sets it yet | — |

`head_priority` is the priority of the head, not of the latest message: `enqueue` sets it only
when the chat was `idle` or new, and `markDone` sets it to the priority of the next head, or `null`
when there is none.

## Enqueue

`enqueue()` is `enqueueBatch()` of one message. The batch is one statement, so the rows and their
chats commit together:

1. the messages go in as one `jsonb` array and are inserted `order by` their position in it, so
   the ids grow in the order of the input;
2. per chat, the first new message is the candidate head;
3. the chat row is upserted: a new chat is inserted as `ready`, an `idle` one becomes `ready`
   with the new head priority, any other state is left alone.

## Claim

`claim(limit)` is one statement:

1. up to `limit` `ready` chats by `next_send_at`, `for update skip locked`: a chat another claimer
   holds is skipped, not waited for;
2. `join lateral` the head of each chat;
3. the head goes to `processing`, but only if it is still `pending`;
4. the chats whose head was claimed go to `processing`, and `next_send_at` moves to `now()`.

Step 4 is what serves the chats in turn: a chat just served goes behind the chats that waited.
Only one head per chat is taken, and a `processing` chat is not `ready`, so a chat never has two
messages in `processing`.

The check in step 3 exists because the head is read from the snapshot of the statement. A chat row
completed and made `ready` again after the snapshot passes step 1 (the lock rereads the newest row
version), while step 2 still sees the old head, already `done` by then. Without the check that head
would be sent twice; with it the chat is left `ready` for the next claim.

The claim does not look at the limits, the priority or the pause yet: `next_send_at` only orders
the chats.

## Mark done

`markDone(id, response)` is a transaction of three statements:

1. lock the chat row of the message;
2. the message goes to `done` with the response and `finished_at`, only from `processing`;
   otherwise the method returns `false` and changes nothing;
3. the chat goes to `ready` with the priority of the next head, or to `idle`.

The statements are separate on purpose. Under `read committed` every statement reads a fresh
snapshot, so step 3, running after the lock, sees a message enqueued while the lock was awaited.
One statement would read its snapshot before waiting for the lock and could leave a chat `idle`
with a `pending` message in it: a message that is never sent.

## The chat lock

The chat row is the lock of its chat. Whatever changes a chat state locks its row before reading
the head, and reads the head in a later statement ([invariant](./invariants.md)). `enqueue`
locks the row through `on conflict do update`: the conflicting row is locked even when the `where`
of the update does not hold. So an enqueue and a completion of one chat are serialized in either
order:

- the enqueue first: the completion waits for its commit and then sees the new message;
- the completion first: the chat becomes `idle`, and the waiting enqueue sees that newest version
  and makes it `ready`.

Both orders are pinned by `test/telegram/outbox/outbox-store.spec.ts`, which lines the calls up
behind a lock held by a third client.

## Code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").
