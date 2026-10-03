# Inbox (telegram/inbox/)

The inbox is being built so that incoming updates become rows in PostgreSQL, any node handles
them, and the updates of one group are handled one at a time, in order, across nodes (the plan is
epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)). It is the counterpart of
the outbox ([`outbox.md`](./outbox.md)) and follows its model without the limits and the pause. No
source or worker uses the directory yet: so far it holds the tables with `InboxStore`
(`store/inbox-store.ts`), which pushes updates, claims them, completes a claimed update and finds
the expired leases, and `InboxFailureHandler` (`inbox-failure-handler.ts`), which picks the outcome
of a failed handler by its error class (`failure-classifier/`) and recovers the expired leases.

## Tables

One migration, `1790980923786_telegram-inbox-tables.ts`, creates both tables with every column
the inbox needs, the later stages included. The columns and what they mean are in its
`createTable` calls and `comment`s; those of `status`, `attempts` and `next_attempt_at` are
replaced by `1791027821646_telegram-inbox-failure-comments.ts`. As in the outbox, the lease is on
the group row, not on the update, and there are no indexes besides the primary keys.

The database does not check the values of `status` and `state`: the store writes them only
through the `InboxStatus` and `InboxGroupState` enums (`store/inbox-store.types.ts`). Of these,
nothing sets `skipped` yet.

The **group** is `(user_id, chat_id)`, the key `getSessionKey()` gives the session of an update
(`telegram/session/session.helper.ts`), so the updates that share a session are handled one at a
time. The caller of `push()` passes the group with the update; the store does not read it off the
update.

The **head** of a group is its first update by `update_id` among the active statuses (`pending`,
`processing`). `update_id` is Telegram's own: it is the primary key, so a redelivered update is
not stored twice, and it is the order inside a group.

A `failed` update is not active, as a `failed` message of the outbox is not
([`outbox.md`](./outbox.md), "Tables"): a failed update that blocks its group holds it through
`blocked`, and one that does not block lets the next update of the group become the head.

### Updates without a session key

An update without a user or a chat is not stored: `user_id` and `chat_id` are `NOT NULL`, and the
caller is to drop such an update before the push, logging a warning, as `HasSessionKeyFilter`
drops it from the pipeline today ([`bot.md`](./bot.md)). Such an update has no session, so the
pipeline would drop it anyway, and with `ALLOWED_UPDATES` of `message` alone (`bot.ts`) none is
requested, as the comment of the filter says.

## Group states

| state | who sets it |
|---|---|
| `idle` | `push` of a new group, for the moment before its updates are inserted, and of a group whose updates were all stored already; `markAsDone` and `markAsFailed` of the last active update |
| `ready` | `push` of a new update into an `idle` group; `markAsDone` and `markAsFailed` when an update is left; `retry` |
| `processing` | `claim` |
| `blocked` | `markAsFailedAndBlockGroup`; `push` leaves it as it is |

## Push

`push()` is `pushBatch()` of one update. The batch is a transaction:

1. every group of the batch is inserted `idle` or, if it has a row, locked, in one statement and
   in key order: `ON CONFLICT DO UPDATE … WHERE false`, as the push of the outbox does with its
   chats ([`outbox.md`](./outbox.md), "Push"). A group that comes twice in a batch is passed once:
   PostgreSQL fails an `ON CONFLICT DO UPDATE` that inserts the same new row twice;
2. the updates go in with `ON CONFLICT (update_id) DO NOTHING`: one stored already, or repeated
   in the batch, is left out without failing the batch. The stored update stays; of the copies
   in one batch, whichever PostgreSQL meets first goes in;
3. every `idle` group that got an update inserted by step 2 becomes `ready`. A group whose
   updates were all left out stays `idle`: it has no head to claim.

The group row is the lock of its group, and `push` and every completion take it before they read
what their change depends on, as in the outbox ([`outbox.md`](./outbox.md), "The chat lock"). So
a push and a completion of one group are serialized in either order: the one that locks second sees
what the first committed, and `test/telegram/inbox/inbox-store.spec.ts` pins both orders of a push
and `markAsDone()`.

The order inside a group is the order of `update_id` among the updates stored as of the snapshot
of the claim (see "Claim"). An update pushed after a later update of its group was claimed is
handled after it.

`update_id` grows only while updates keep coming: after a week without updates Telegram picks the
next one at random (`update_id` of `Update` in the Bot API docs). An update still active from
before such a gap would then be claimed after the newer updates of its group, and a new id equal to
a stored one would be left out as a redelivery. Nothing keeps an update active for a week yet.

## Claim

`claim(limit, worker)` throws `InvalidClaimLimit` on a `limit` that is not a whole number from 1 to
`Number.MAX_SAFE_INTEGER`. Otherwise it is one statement, atomic without a transaction:

1. up to `limit` `ready` groups whose `next_attempt_at` has passed, with the head of each
   (`CROSS JOIN LATERAL`), by `next_attempt_at`, then by the group key,
   `FOR UPDATE OF … SKIP LOCKED`: a group another claimer holds is skipped, not waited for;
2. the head goes to `processing`, but only if it is still `pending`; its `attempts` stay as they
   are, the completion writes the attempt (see "Completions");
3. the groups whose head was claimed go to `processing`, `next_attempt_at` moves to `now()`, and
   the group is leased to the claim (see "The lease");
4. the answer: the claimed updates by `update_id`, each with its group, the update, the
   `lockToken` of the claim, `startedAt` (`now()` of the claim), the `worker` passed to the claim
   and `earlierAttempts`, the length of its `attempts`.

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
The completion ends the lease: both columns go back to `NULL`. A lease that passes before the
completion is recovered (see "Lease recovery"). Nothing checks how long the lease is against how
long a handler runs ([`invariants.md`](./invariants.md), "The inbox").

The handling is at least once. A node that dies after the handler ran and before its completion
commits leaves the update `processing`; once the lease is recovered, the update is handled again:
the user may get a reply twice, and a conversation may replay a step. The inbox cannot tell such an
update from one whose handler never ran. A retry runs the whole handler again too: a transient
failure after the handler has replied, a lost connection on a later write, gives the user the
reply once per attempt, up to `INBOX_MAX_ATTEMPTS` (see "Outcomes").

## Completions

A claimed update is completed by one of the public methods of the store that take an `InboxLease`:
the update `claim()` gave out, or an expired lease read by `findExpiredLeases()` (see "Lease
recovery"). What each does to the update and the group is read off its body. Each is a transaction
through the private `complete()`:

1. lock the group row of the update; a missing update throws `InboxUpdateNotLeased`;
2. the fence: a `lockToken` that is not the group's changes nothing and is logged as a warning,
   with the group, its own token and the error the completion carried. The lease has passed to
   another claim, and the group holds the token of that claim, or an earlier completion of the same
   claim has ended it, and the token is `null`;
3. the update leaves `processing`. An update that is not `processing` under the group's own token
   is another update of the group, and the method throws `InboxUpdateNotLeased`;
4. the group state, and the end of the lease.

Step 3 appends the attempt to `attempts`, whole: `started_at` and `worker` from the lease, the
error, `null` for `done`, and `finished_at` of `now()`, as the completions of the outbox do
([`outbox.md`](./outbox.md), "Completions"). Nothing is written into `attempts` before the
completion, so a node that dies while it handles an update leaves no trace of the attempt; the
recovery of its lease appends one.

`retry` sets `next_attempt_at` of the group to `now()` plus the delay it is given. The retried
update stays the head of its group, so the group waits with it: the updates behind it are not
claimed before it, while the other groups are.

Every update of the store sets `updated_at = now()` itself; there is no trigger.

## Failures

`InboxFailureHandler.handle(update, error)` takes a claimed update whose handler threw, with the
error as the handling threw it, and completes the update by the class of the error. Nothing calls it
yet: the loop that handles the updates is
[#628](https://github.com/yuldashevsardor/telegram-bot/issues/628).

`Bot.handleUpdate()` wraps an error of the middleware into a `BotError` whose `ctx` holds the whole
context, the `Api` and its token included (`handleUpdate()` in grammY's `bot.js`). The handler takes
the handler's own error out of it, `BotError.error`, for both the class and the attempt.

### Error classes

`InboxFailureClassifier.classify(error)` (`failure-classifier/inbox-failure-classifier.ts`) sorts
the error into the `InboxFailureKind` values, the classes of the epic
([#618](https://github.com/yuldashevsardor/telegram-bot/issues/618), "Error classes") without the
flood. Which error falls into which class, and why, is read off the method, its constants and
their comments. In short:

- A `GrammyError` or an `HttpError` is classified by `TelegramBotApiFailureClassifier`
  ([`outbox.md`](./outbox.md), "Error classes"), and its class is mapped: `Undeliverable` stays
  `Undeliverable`, so a user who blocked the bot does not block their own group; `Unexpected` stays
  `Unexpected`; the rest are `Transient`.
- A 429 (`Flood`) and a 401 (`Unauthorized`) are `Transient`. Through the outbox neither reaches a
  handler: the outbox waits a 429 out and pauses on a 401 itself. One that does came from a call
  that bypassed the outbox, and the update can be handled once Telegram lets the bot call again.
  The inbox does not wait `retry_after` out: a 429 that asks for longer than the retry delays of
  all the attempts, some 2 to 4 minutes at the defaults, runs them out and blocks the group, as a
  401 of a token that stays revoked does.
- A lost database connection is `Transient`: the codes postgres.js gives a query whose connection
  went away, the codes of the Node socket it passes on, the SQLSTATE class `08` (connection
  exception), the codes of a server that stops or starts and of one with no connection slot left.
  So are a deadlock and a serialization failure, which PostgreSQL resolves by rolling one
  transaction back: the same handler passes once it runs again. The outcome may still be
  unwritable while the connection is down; the lease recovery then takes the update back (see
  "Lease recovery").
- The `cause` chain is read too, and its first link that is not `Unexpected` decides: a lost
  connection a caller wrapped into its own error is `Transient`. `UserService` wraps a failed save
  of the user, made on every update, into `UserCreateError` or `UserEditError`; read only at the
  top, a restart of PostgreSQL during that save would block the group.
- Anything else is `Unexpected`, a bug or a timeout waiting for the outbox included
  (`OutboxResultTimeout`): a reply that took too long may still go out, and the epic blocks the
  group on it. So is a wait the outbox stopped (`OutboxResultWaiterStopped`), although it says only
  that the node is shutting down: the loop that handles the updates is to keep such a handler away
  from `handle()` and release its update, or an ordinary restart blocks the group
  ([#628](https://github.com/yuldashevsardor/telegram-bot/issues/628)).

### Outcomes

Which completion each class gets is read off `applyOutcome()` and `retryOrBlock()` of the handler:
a `Transient` failure is retried, or fails and blocks the group on the last attempt; an
`Undeliverable` one fails without blocking; an `Unexpected` one fails and blocks. A blocked group is
logged at `error` by the store, with the group, the update and the error; a fenced completion logs
no error.

Every attempt counts towards `INBOX_MAX_ATTEMPTS`, whatever it ended with: the attempt being handled
is `earlierAttempts + 1`, checked on a transient failure only. The count covers the whole history of
the update, as in the outbox ([`outbox.md`](./outbox.md), "Outcomes").

The retry delay is the outbox's: `OutboxRetryDelay.computeMs()` of the counted attempts, with the
`OUTBOX_RETRY_` variables ([`outbox.md`](./outbox.md), "Retry delay"). The error goes into the
attempt as `OutboxErrorSerializer` writes it, with its class in `kind`
([`outbox.md`](./outbox.md), "Outcomes").

### Lease recovery

`InboxFailureHandler.recoverExpiredLeases()` takes back the updates of the groups whose lease has
passed: the node that claimed them is presumed dead. The handling loop is to call it on a timer.

1. `InboxStore.findExpiredLeases()` reads every group whose `locked_until` is behind `now()`, with
   its `processing` update, as a lease under the group's own `lock_token`. It reads without a lock
   and leaves the lease as it is.
2. Each lease is a transient failure, completed as one: the update goes back to `pending` with the
   retry delay of its attempt, or, on the last attempt of `INBOX_MAX_ATTEMPTS`, fails and blocks its
   group. The completion appends an attempt with the error `InboxLeaseExpired` of class `transient`
   and `worker: null`, and `started_at` of `locked_until` minus `INBOX_LEASE_DURATION`. The leases
   are completed one after another, and a completion that throws ends the call.

The recovery completes the update through the same fenced completions as the node that claimed it,
under the token of that claim, so whichever comes first changes the update and the other one is
fenced off and logged as a stale lock token, as in the outbox ([`outbox.md`](./outbox.md), "Lease
recovery", where the rest of the reasoning holds for the inbox as well). The fence checks the token,
not `locked_until`, so a lease that has passed must never be extended
([`invariants.md`](./invariants.md), "The inbox").

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

`InboxFailureHandler` is there too: its spec runs it over the real store, so that each error class
is pinned by the rows it leaves rather than by the calls a fake store records. Its decisions are a
`switch` over the class and the count of attempts. The classes themselves are in
`InboxFailureClassifier`, which needs no database and is mutated.

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

The updates go to the database as JSON text cast to `jsonb`, not through `sql.json()`; why is in
the comment of `pushBatch()`.
