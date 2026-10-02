# Inbox (telegram/inbox/)

The inbox is being built so that incoming updates become rows in PostgreSQL, any node handles
them, and the updates of one group are handled one at a time, in order, across nodes (the plan is
epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)). It is the counterpart of
the outbox ([`outbox.md`](./outbox.md)) and follows its model without the limits and the pause. No
source or worker uses the directory yet: so far it holds the tables with `InboxStore`
(`store/inbox-store.ts`), which pushes updates, claims them and marks them done.

## Tables

One migration, `1790980923786_telegram-inbox-tables.ts`, creates both tables with every column
the inbox needs, the later stages included. The columns and what they mean are in its
`createTable` calls and `comment`s. As in the outbox, the lease is on the group row, not on the
update, and there are no indexes besides the primary keys.

The database does not check the values of `status` and `state`: the store writes them only
through the `InboxStatus` and `InboxGroupState` enums (`store/inbox-store.types.ts`). Of these,
nothing sets `failed`, `skipped` and `blocked` yet.

The **group** is `(user_id, chat_id)`, the key `getSessionKey()` gives the session of an update
(`telegram/session/session.helper.ts`), so the updates that share a session are handled one at a
time. The caller of `push()` passes the group with the update; the store does not read it off the
update.

The **head** of a group is its first update by `update_id` among the active statuses (`pending`,
`processing`). `update_id` is Telegram's own: it is the primary key, so a redelivered update is
not stored twice, and it is the order inside a group.

### Updates without a session key

An update without a user or a chat is not stored: `user_id` and `chat_id` are `NOT NULL`, and the
caller drops such an update before the push, logging a warning, as `HasSessionKeyFilter` drops it
from the pipeline today ([`bot.md`](./bot.md)). Such an update has no session, so the pipeline
would drop it anyway, and with `ALLOWED_UPDATES` of `message` alone (`bot.ts`) none is requested,
as the comment of the filter says.

## Group states

| state | who sets it |
|---|---|
| `idle` | `push` of a new group, for the moment before its updates are inserted, and of a group whose updates were all stored already; `markAsDone` of the last active update |
| `ready` | `push` of a new update into an `idle` group; `markAsDone` when an update is left |
| `processing` | `claim` |
| `blocked` | nothing yet; `push` leaves it as it is |

## Push

`push()` is `pushBatch()` of one update. The batch is a transaction:

1. every group of the batch is inserted `idle` or, if it has a row, locked, in one statement and
   in key order: `ON CONFLICT DO UPDATE … WHERE false`, as the push of the outbox does with its
   chats ([`outbox.md`](./outbox.md), "Push"). A group that comes twice in a batch is passed once:
   PostgreSQL fails an `ON CONFLICT DO UPDATE` that inserts the same new row twice;
2. the updates go in with `ON CONFLICT (update_id) DO NOTHING`: one stored already, or repeated
   in the batch, is left out without failing the batch, and the first copy stays;
3. every `idle` group that got an update inserted by step 2 becomes `ready`. A group whose
   updates were all left out stays `idle`: it has no head to claim.

The group row is the lock of its group, and `push` and `markAsDone` take it before they read what
their change depends on, as in the outbox ([`outbox.md`](./outbox.md), "The chat lock"). So a push
and a completion of one group are serialized in either order: the one that locks second sees what
the first committed, and `test/telegram/inbox/inbox-store.spec.ts` pins both orders.

The order inside a group is the order of `update_id` among the updates stored when the head is
claimed. An update pushed after a later update of its group was claimed is handled after it.

## Claim

`claim(limit)` throws `InvalidClaimLimit` on a `limit` that is not a whole number from 1 to
`Number.MAX_SAFE_INTEGER`. Otherwise it is one statement, atomic without a transaction:

1. up to `limit` `ready` groups whose `next_attempt_at` has passed, with the head of each
   (`CROSS JOIN LATERAL`), by `next_attempt_at`, then by the group key,
   `FOR UPDATE OF … SKIP LOCKED`: a group another claimer holds is skipped, not waited for;
2. the head goes to `processing`, but only if it is still `pending`;
3. the groups whose head was claimed go to `processing`, `next_attempt_at` moves to `now()`, and
   the group is leased to the claim (see "The lease");
4. the answer: the claimed updates by `update_id`, each with its group, the update and the
   `lockToken` of the claim.

Step 3 is what serves the groups in turn: a group just served goes behind the groups that waited.
Only one head per group is taken, and a `processing` group is not `ready`, so a group never has two
updates in `processing`.

Step 1 reads the head from the snapshot of the statement, taken before the lock, so a head
completed after the snapshot is turned away by the check of step 2 and its group is left `ready`
for the next claim, as in the outbox ([`outbox.md`](./outbox.md), "Pull").

## The lease

A claim leases each group it claimed: `locked_until` is `now()` plus `leaseDurationMs`
(`INBOX_LEASE_DURATION`), and `lock_token` is the token of the claim, a `randomUUID()` the code
makes before the statement and returns with every update as `lockToken`. One token for the groups
of a claim is enough, for the reason the outbox gives ([`outbox.md`](./outbox.md), "The lease").
The completion ends the lease: both columns go back to `NULL`. Nothing recovers a lease that has
passed yet, so such a group stays `processing`.

## Completion

`markAsDone(lease)` is a transaction:

1. lock the group row of the update; a missing update throws `InboxUpdateNotLeased`;
2. the fence: a `lockToken` that is not the group's changes nothing and is logged as a warning.
   The lease has passed to another claim, or an earlier completion of the same claim has ended
   it;
3. the update goes from `processing` to `done` with `finished_at`. An update that is not
   `processing` under the group's own token is another update of the group, and the method throws
   `InboxUpdateNotLeased`;
4. the group goes `ready` while it has an active update left, `idle` otherwise, and the lease ends.

Every update of the store sets `updated_at = now()` itself; there is no trigger.

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

The updates go to the database as JSON text cast to `jsonb`, not through `sql.json()`; why is in
the comment of `pushBatch()`.
