# Inbox (telegram/inbox/)

The inbox makes incoming updates rows in PostgreSQL, so that any node handles them, and the
updates of one group are handled one at a time, in order, across nodes (the plan is epic
[#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)). It is the counterpart of the
outbox ([`outbox.md`](./outbox.md)) and follows its model without the limits and the pause. The
directory holds the tables with `InboxStore` (`store/inbox-store.ts`), which pushes updates,
claims them, extends a lease, completes a claimed update, notifies of the groups that become
`ready`, finds the expired leases, cleans up the tables, counts the blocked groups and unblocks a
group by hand;
`InboxFailureHandler` (`inbox-failure-handler.ts`), which picks the outcome of a failed handler by
its error class (`failure-classifier/`) and recovers the expired leases; `InboxLeaseReleaser`
(`inbox-lease-releaser.ts`), which hands the update of a stopping node back; the worker that
handles the updates through the bot: `InboxRunner` with its update source and update processor,
and the timers of `InboxMaintenance`; and `InboxPollingSource` (`inbox-polling-source.ts`), which
fills the inbox from Telegram. `Application` starts and stops the worker and the polling source
([`application.md`](./application.md), "Start", "Stop").

## Tables

One migration, `1790980923786_telegram-inbox-tables.ts`, creates both tables with every column
the inbox needs, the later stages included. The columns and what they mean are in its
`createTable` calls and `comment`s; those of `status`, `attempts` and `next_attempt_at` are
replaced by `1791027821646_telegram-inbox-failure-comments.ts`. As in the outbox, the lease is on
the group row, not on the update.

The indexes are picked by the plans of the load test
([`inbox-load-test.md`](./inbox-load-test.md)), not ahead of the queries. Besides the primary keys
there are three. `1791417600000_telegram-inbox-head-index.ts` adds
`telegram_inbox_active_group_idx` on `(user_id, chat_id, update_id)` of the active updates: the head
of a group for the claim and for `releaseGroup()` is its first entry, and the lease recovery reads
the entries of a group up to its first `processing` one (see "Lease recovery"). Its
`status` is in the predicate, so no update is HOT, and every update leaves dead entries a head
lookup walks until a vacuum cleans them. So the same migration sets the vacuum options of
`telegram_inbox` that the head index migration of the outbox sets for `telegram_outbox`:
`vacuum_index_cleanup = ON` and a cap on the dead rows that bring autovacuum
(`autovacuum_vacuum_max_threshold`); their reasons are in
[`outbox-load-test.md`](./outbox-load-test.md), "Vacuum of the head index".
`1791504000000_telegram-inbox-ready-groups-index.ts` adds `telegram_inbox_ready_groups_idx` on
`(next_attempt_at, user_id, chat_id)` of the `ready` groups: the claim takes them in that order, so
it reads as many groups as it claims. `1791676800000_telegram-inbox-finished-index.ts` adds
`telegram_inbox_finished_at_idx` on `finished_at` of the `done` and `skipped` updates, the ones the
cleanup deletes (see "Cleanup"): without it the call that finds nothing to delete reads the whole
table. As the index of the outbox cleanup ([`outbox.md`](./outbox.md), "Tables"), it holds an entry
for every `done` and `skipped` update the cleanup has not deleted yet, and every completion but a
failure adds one.

The database does not check the values of `status` and `state`: the store writes them only
through the `InboxStatus` and `InboxGroupState` enums (`store/inbox-store.types.ts`). Of these,
only the unblock of a group sets `skipped` (see "Unblocking a group").

The **group** is `(user_id, chat_id)`, the key `getSessionKey()` gives the session of an update
(`telegram/session/session.helper.ts`), so the updates that share a session are handled one at a
time. The caller of `push()` passes the group with the update; the store does not read it off the
update.

The **head** of a group is its first update by `update_id` among the active statuses (`pending`,
`processing`). `update_id` is Telegram's own: it is the primary key, so a redelivered update is
not stored twice, and it is the order inside a group.

A `failed` update is not active, as a `failed` message of the outbox is not
([`outbox.md`](./outbox.md), "Tables"): a failed update that blocks its group holds it through
`blocked`, and one that does not block lets the next update of the group become the head. A person
unblocks a group by hand with `make inbox-retry` or `make inbox-skip` (see "Unblocking a group").

### Updates without a session key

An update without a user or a chat is not stored: `user_id` and `chat_id` are `NOT NULL`, and the
polling source drops such an update before the push, logging a warning, as `HasSessionKeyFilter`
would drop it in the pipeline ([`bot.md`](./bot.md)). Such an update has no session, so the
pipeline would drop it anyway, and with `ALLOWED_UPDATES` of `message` alone (`bot.types.ts`) none
is requested, as the comment of the filter says.

## Group states

| state | who sets it |
|---|---|
| `idle` | `push` of a new group, for the moment before its updates are inserted, and of a group whose updates were all stored already; `markAsDone` and `markAsFailed` of the last active update; `skipBlockedGroup` when no active update is left |
| `ready` | `push` of a new update into an `idle` group; `markAsDone` and `markAsFailed` when an update is left; `retry`; `retryBlockedGroup`; `skipBlockedGroup` when an update is left |
| `processing` | `claim` |
| `blocked` | `markAsFailedAndBlockGroup`; `push` leaves it as it is |

An `idle` group loses its row to `deleteIdleGroups()` (see "Cleanup"); the next `push` inserts it
again as a new group.

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
   updates were all left out stays `idle`: it has no head to claim;
4. if step 3 made any group `ready`, one notification on the ready channel (see "Ready
   notifications"). A batch that made none, of redeliveries or of updates of groups already
   `ready`, `processing` or `blocked`, sends none.

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
a stored one would be left out as a redelivery. An update can stay active that long: a blocked
group keeps its updates until a person unblocks it (see "Unblocking a group"), and a stop of the
bot keeps every active update until the next start, a `processing` one of a node that died until
the lease recovery after it (see "Lease recovery").

## Claim

`claim(limit, worker)` throws `InvalidClaimLimit` on a `limit` that is not a whole number from 1 to
`Number.MAX_SAFE_INTEGER`. Otherwise it is one statement, atomic without a transaction:

1. up to `limit` `ready` groups whose `next_attempt_at` has passed, by `next_attempt_at`, then by
   the group key, `FOR UPDATE SKIP LOCKED`: a group another claimer holds is skipped, not waited
   for. The groups are taken before their heads are looked up, so the claim reads as many heads as
   it takes groups (`inbox-load-test.md`, "The claim of 100 k groups"). A `ready` group always has
   a pending head (see "Group states"), so the order needs nothing from it; a `ready` group without
   one would take a place among the `limit` groups and claim nothing;
2. the head of each of those groups (`CROSS JOIN LATERAL`);
3. the head goes to `processing`, but only if it is still `pending`; its `attempts` stay as they
   are, the completion writes the attempt (see "Completions");
4. the groups whose head was claimed go to `processing`, `next_attempt_at` moves to `now()`, and
   the group is leased to the claim (see "The lease");
5. the answer: the claimed updates by `update_id`, each with its group, the update, the
   `lockToken` of the claim, `startedAt` (`now()` of the claim), the `worker` passed to the claim
   and `earlierAttempts`, the length of its `attempts`.

Step 4 is what serves the groups in turn: a group just served goes behind the groups that waited.
Only one head per group is taken, and a `processing` group is not `ready`, so a group never has two
updates in `processing`.

Step 2 reads the head from the snapshot of the statement, taken before the lock, so a head
completed after the snapshot is turned away by the check of step 3 and its group is left `ready`
for the next claim, as in the outbox ([`outbox.md`](./outbox.md), "Pull").

## The lease

A claim leases each group it claimed: `locked_until` is `now()` plus `leaseDurationMs`
(`INBOX_LEASE_DURATION`), and `lock_token` is the token of the claim, a `randomUUID()` the code
makes before the statement and returns with every update as `lockToken`. One token for the groups
of a claim is enough, for the reason the outbox gives ([`outbox.md`](./outbox.md), "The lease").
The completion ends the lease: both columns go back to `NULL`. A lease that passes before the
completion is recovered (see "Lease recovery"). Nothing checks how long the lease is against how
long a handler runs ([`invariants.md`](./invariants.md), "The inbox").

`extendLease(lease)` moves `locked_until` of the update's group to `now()` plus `leaseDurationMs`,
so a handler that runs longer than one lease, a conversion that runs FontForge up to four times,
keeps its group. It is one statement, and it extends only a lease that has not passed, under the
group's own token, and returns whether it did. `false` means the lease has passed, a completion has
ended it, or it went to another claim: the recovery takes the update back, or has done so already,
and the completion of the caller will be fenced. A lease that has passed is not extended because
the recovery tells its lease by the token, not by `locked_until` (see "Lease recovery"): extended,
it would leave the update to the recovery and to the handler both. Only the group of the update is
extended, not the other groups of the same claim, which share its token.

The check is made by `now()`, fixed at the start of the statement, and the recovery reads the
expired leases without a lock (see "Lease recovery"). An extension whose statement starts before the
lease passes and commits after a recovery has read the lease as passed returns `true`, and the
recovery then completes the update all the same: the extension does not change the token, and the
completion is fenced by the token alone. The window runs from the start of the statement to its
commit, and it includes a wait for the group row that a push of the same group, a fenced
completion or an unblock refused with `InboxGroupNotBlocked` holds. They only lock the row (see
"Push", step 1, and "Completions", step 2), so PostgreSQL does not check the row again after
the wait, and a clock read at the check would not help. An applied completion writes the row and
clears the token, and the extension that waited is refused. A caller that extends well before the
lease passes does not meet the window.

An extension moves `locked_until` only: the recovery of an extended lease still writes the start of
the claim into the attempt (see "Lease recovery").

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

1. lock the group row of the update; a missing update throws `InboxUpdateNotLeased`. A group row
   that is missing while its update is stored changes nothing and is logged as a warning:
   `deleteIdleGroups()` removed the group once it went `idle`, so no lease is left (see "Cleanup");
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
update stays the head of its group, unless an update pushed with a smaller `update_id` is before it
(see "Push"), so the group waits with it: the updates behind it are not claimed before it, while
the other groups are.

Every update of the store sets `updated_at = now()` itself; there is no trigger.

## Ready notifications

The store sends `pg_notify` on `telegram_inbox_ready` (`InboxChannel.Ready`), with an empty
payload, in the transaction of every write that leaves a group `ready`: a push that made a group
`ready` (see "Push"), `markAsDone()` and `markAsFailed()` that leave an update behind, every
`retry()`, and both unblocks when they leave the group `ready` (see "Unblocking a group"). A
completion that leaves its group `idle` or `blocked`, a fenced one and one that rolls back send
none. The notification goes through the transaction, so PostgreSQL delivers it on commit and a
worker woken by it sees the group, as the ready channel of the outbox does
([`outbox.md`](./outbox.md), "Push"). It names no group: a worker takes what it claims. Every
retry notifies, one with a delay too: the store does not tell the release on stop, a retry with no
delay (see "Release on stop"), from the others. A worker woken by a retry with a delay claims
nothing until the delay passes, and the end of the delay notifies no one: a worker learns of it from
a claim of its own, made on a timer.

`listenReady(onReady)` listens on the channel, on the listening connection of the client
([`storage.md`](./storage.md), "LISTEN"). `onReady` is called on every notification and every time
the listening starts, the first time and after a reconnect: a write committed while the connection
was down reached no one. `InboxUpdateSource` listens (see "The update source").

## The update source

`InboxUpdateSource` (`inbox-update-source.ts`) is what the runner of a node takes the claimed
updates from. `stream(worker)` makes the one async generator of the node, with the `worker` of the
loop, and follows the message source of the outbox ([`outbox.md`](./outbox.md), "The message
source") without its limits. The source serves one generator ([`invariants.md`](./invariants.md),
"The inbox").

- **One update per claim.** The generator claims with a `limit` of 1 (`CLAIM_LIMIT`), and only when
  the loop asks for the next update. At the stop the runner starts the one update it has got and
  closes the generator (see "The runner"): a claim of more would leave the rest claimed by the
  stopping node until their lease passes.
- **The sleep.** A claim that got nothing puts the generator to sleep for a random point from
  100 ms to 1 s (`MIN_SLEEP_MS`, `MAX_SLEEP_MS`), drawn for each sleep. A claim answers with no
  time to wait for, and the end of a retry delay notifies no one (see "Ready notifications"): the
  sleep is how a node learns of it. Being random, it spreads out the nodes that found nothing
  together.
- **The wake-up.** The generator starts listening on the ready channel
  (`InboxStore.listenReady()`) at its start. A failed start is logged at `warning` and is not
  repeated, for the reason the outbox gives; until the listening starts, the timed sleep serves. A
  start that fails after the stop is not logged: a clean shutdown may close the database under it. A
  notification wakes the sleeping generator, and so does every start of the listening. A
  notification that comes during a claim makes the generator claim again instead of sleeping: the
  claim may have read the tables before the write it announces committed.
- **A failed claim** is logged at `error`, and the generator sleeps and claims again: the source
  ends only on stop. No notification cuts that sleep short: pushes go on while the claims fail, and
  the generator would retry and log at their rate. A claim that fails after the stop is logged at
  `warning` and ends the generator.
- **The stop.** `stop()` ends the generator: a sleeping one at once, one whose claim is in progress
  once it has handed out what the claim got, and one waiting for the loop at its next update. A
  generator made after the stop ends without a claim and does not start the listening: the database
  may be closed by then.

## The update processor

`InboxUpdateProcessor` (`inbox-update-processor.ts`) takes one claimed update to its outcome:

1. `init()` of the grammY bot with the signal of the update: a no-op once grammY knows the bot,
   otherwise a `getMe` that grammY retries on a network failure until the signal aborts it. An
   `init()` that throws with the signal aborted is released (see "Release on stop"); one that throws
   otherwise goes to `InboxFailureHandler.handle()`, as a failed handler does.
2. An update whose signal is aborted by now is released without reaching its handler: one a claim in
   progress handed out after the stop deadline, or one whose `init()` the deadline came during
   (see "The runner").
3. `handleUpdate()` of the grammY bot, with the runner told when the handler starts and when it
   ends (see "The runner"), then the outcome:
   - success: `markAsDone()`;
   - `OutboxResultWaiterStopped` as the handler's own error, the one grammY wraps into
     `BotError.error`: the release on stop, never `handle()` (see "Error classes"). The handler has
     settled by then, as the release requires. A stopped wait that the handler wrapped into an error
     of its own is not told apart and fails as `Unexpected`;
   - any other error: `InboxFailureHandler.handle()`, with the error as grammY threw it.

The lease is extended by `InboxLeaseExtension` (`inbox-lease-extension.ts`) from the start of
`init()` to the end of the handler: every third of `INBOX_LEASE_DURATION` (`EXTENSIONS_PER_LEASE`),
each extension timed from the end of the previous one, so a handler that runs longer than one lease
keeps its group (see "The lease"). A refused
extension is logged at `warning` and ends the extension: the lease has passed or gone to another
claim, the recovery takes the update back, and the completion of this node will be fenced. The
handler runs on all the same: nothing can cut it short. A failed extension is logged at `warning`
and left to the next one. A warning that throws is dropped: the extension runs from a timer, and
nothing awaits it. The extension ends before the outcome is written, so the completion that ends the
lease meets no extension of its own node: one still in flight then has its answer dropped. It ends
when the signal aborts too: the stop has given the update up, and the database is closed after the
stop.

A completion or a release that throws is not caught here: the runner logs it (see "The runner").

## The runner

`InboxRunner` (`inbox-runner.ts`) handles the updates of a node: one loop over `INBOX_CONCURRENCY`
slots. It is a loop of its own beside `OutboxRunner` and is built as that one is
([`outbox.md`](./outbox.md), "The runner"). `start()` makes the generator of the source, once, with
the worker of the loop: the host, the pid and a `randomUUID()` made with the loop.

1. The loop hands each update of the generator to the processor at once, without waiting for it
   to settle: the lease counts from the claim. Then it waits until a slot is free, and only then
   asks the generator for the next update.
2. The loop writes no outcome: the processor does. A `process()` that rejects, or throws
   synchronously, is logged at `error` and frees its slot; its update stays `processing` until the
   recovery of its lease. A source that throws is logged at `error` and ends the loop: the node
   takes no more updates until it restarts. A log that throws in either case is dropped: the
   rejection of a promise nobody awaits would reach `unhandledRejection`, which ends the process
   (`src/app.ts`).

`stop()`:

1. stops the source, and the loop asks it for nothing more. A claim in progress hands out its update
   first, and the loop starts it as any other; one handed out after the deadline starts with its
   signal aborted, and the processor releases it without handling it;
2. waits for the handlers in flight up to `INBOX_STOP_TIMEOUT`, counted from the call of `stop()`;
3. aborts the updates still in flight at the deadline, which ends the extension of their leases.
   The stop waits for each one outside its handler: one whose handler has not started never starts
   it, and the processor releases it; one whose handler has ended is having its outcome written.
   Both are writes the database must still be open for. One in its handler is left running: grammY
   gives a handler no signal, so it cannot be cut short, and a wait for it would hold the stop up
   for as long as it runs. The stop logs the update ids of those at `warning` and returns without
   them. Such a handler runs on until the process ends: if it settles while the
   database is open, its outcome is written as any other; otherwise the recovery takes its update
   back once the lease passes. `Application` keeps the database open for them with
   `waitForHandlersLeftRunning()` (see "Release on stop").

The deadline bounds neither the wait for a claim in progress, as in the outbox, nor the wait for the
writes of step 3.
`ConfigValuesBuilder` counts `INBOX_STOP_TIMEOUT` in the sum it checks against
`GRACEFUL_SHUTDOWN_TIMEOUT` ([`application.md`](./application.md), "Stop"). Nothing checks the
connections of the runner against `DATABASE_CONNECTION_LIMIT`, as `checkOutboxConcurrency()` checks
those of the outbox.

## Maintenance

`InboxMaintenance` (`maintenance/inbox-maintenance.ts`) runs the tasks of the inbox on the timers of
every node, apart from the runner, as `OutboxMaintenance` runs those of the outbox
([`outbox.md`](./outbox.md), "Maintenance"), with no status line. It takes its three intervals as
one `inbox.maintenance` object (`InboxMaintenanceSettings`):

- `InboxFailureHandler.recoverExpiredLeases()` (see "Lease recovery"), every
  `INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL`;
- `deleteFinishedUpdates()` and `deleteIdleGroups()` (see "Cleanup"), each every
  `INBOX_MAINTENANCE_CLEANUP_INTERVAL` on a timer of its own. A batch that deleted anything is
  followed by the next one at once, until a batch deletes nothing or the maintenance stops;
- the line of the blocked groups, every `INBOX_MAINTENANCE_BLOCKED_LOG_INTERVAL`: an `error` with
  the number `InboxStore.countBlockedGroups()` counts in `telegram_inbox_groups`, written only
  while it is above 0, as the line of the blocked chats of the outbox. It names the targets that
  unblock a group, with their arguments, and the section of `README.md` that finds the groups,
  "Unblocking a chat or a group". The outbox writes its own line, so while both queues have
  something blocked a node writes two.

A task runs first one interval after `start()`, and its next run is timed from the end of the
previous one, so two runs of a task on one node never overlap. A failed run is logged at `error` and
left to the next one. The update of a node that died is claimed again after its lease, up to one
`INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL` more and the retry delay of its attempt. `stop()` clears
the timers and waits for the runs in progress, so the database can be closed after it.

## Unblocking a group

`make inbox-retry user=<id> chat=<id>` is `InboxStore.retryBlockedGroup()` and `make inbox-skip
user=<id> chat=<id>` is `skipBlockedGroup()`. They do for a blocked group what the targets of the
outbox do for a blocked chat ([`outbox.md`](./outbox.md), "Unblocking a chat"): the failed update
that blocked the group, the one that failed last, goes back to `pending` and is the head again, or
becomes `skipped` with `finished_at` set. A retried update is not the head when an update pushed
with a smaller `update_id` is before it (see "Push"). Afterwards the group is `idle` when no active
update is left, not `ready`, which no claim would serve. A group that is not blocked throws
`InboxGroupNotBlocked`. A group left `ready` is notified (see "Ready notifications").
`test/telegram/inbox/inbox-store.spec.ts` lines up a push and a skip in both orders.

## Failures

`InboxFailureHandler.handle(update, error)` takes a claimed update whose handler threw, with the
error as the handling threw it, and completes the update by the class of the error.
`InboxUpdateProcessor` calls it (see "The update processor").

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
  that the node is shutting down: `InboxUpdateProcessor` keeps such a handler away from `handle()`
  and releases its update (see "The update processor"), or an ordinary restart would block the group
  of every update in flight.

### Outcomes

Which completion each class gets is read off `applyOutcome()` and `retryOrBlock()` of the handler:
a `Transient` failure is retried, or fails and blocks the group on the last attempt; an
`Undeliverable` one fails without blocking; an `Unexpected` one fails and blocks. A blocked group is
logged at `error` by the store, with the group, the update and the error; a fenced completion logs
no error. Nothing else is logged: a `Transient` failure that is retried and an `Undeliverable` one
leave their error in the `attempts` of the update and in no log line, so during an outage of
PostgreSQL the retries show only in the inbox tables.

Every attempt counts towards `INBOX_MAX_ATTEMPTS`, whatever it ended with: the attempt being handled
is `earlierAttempts + 1`, checked on a transient failure only. The count covers the whole history of
the update, as in the outbox ([`outbox.md`](./outbox.md), "Outcomes").

The retry delay is the one the outbox and the inbox share: `RetryDelay.computeMs()` of the counted
attempts, with the `OUTBOX_RETRY_` variables ([`outbox.md`](./outbox.md), "Retry delay"). The
error goes into the attempt as `OutboxErrorSerializer` writes it, with its class in `kind`
([`outbox.md`](./outbox.md), "Outcomes").

### Lease recovery

`InboxFailureHandler.recoverExpiredLeases()` takes back the updates of the groups whose lease has
passed: the node that claimed them is presumed dead. `InboxMaintenance` calls it on a timer (see
"Maintenance").

1. `InboxStore.findExpiredLeases()` reads every group whose `locked_until` is behind `now()`, with
   its `processing` update, as a lease under the group's own `lock_token`. It reads without a lock
   and leaves the lease as it is. The update is the first `processing` one of the group by
   `update_id`, in the head index, so the lookup stops at it: the claim makes the head
   `processing`, and the lookup reads one live entry a group, where a search by the status alone
   read every active update of the group ([`inbox-load-test.md`](./inbox-load-test.md), "The lease
   recovery"). Not the head alone, as the outbox takes it ([`outbox.md`](./outbox.md), "Lease
   recovery"): an update pushed with a smaller `update_id` while the group is `processing` (see
   "Push", on `update_id` after a week without updates) is the head before the `processing` one, and
   a lookup of the head would leave such a group `processing` for good, its lease never recovered.
2. Each lease is a transient failure, completed as one: the update goes back to `pending` with the
   retry delay of its attempt, or, on the last attempt of `INBOX_MAX_ATTEMPTS`, fails and blocks its
   group. The completion appends an attempt with the error `InboxLeaseExpired` of class `transient`
   and `worker: null`, and `started_at` of the claim: `updated_at` of the `processing` update,
   which the claim sets and nothing writes until the completion. Not `locked_until` minus
   `INBOX_LEASE_DURATION`, as the outbox derives it: an extension moves `locked_until`. The leases
   are completed one after another, and a completion that throws ends the call.

The recovery completes the update through the same fenced completions as the node that claimed it,
under the token of that claim, so whichever comes first changes the update and the other one is
fenced off and logged as a stale lock token, as in the outbox ([`outbox.md`](./outbox.md), "Lease
recovery", where the same holds for a second recovery of the lease by another node). The fence
checks the token, not `locked_until`, so a lease that has passed must never be extended
([`invariants.md`](./invariants.md), "The inbox"), and `extendLease()` refuses one (see "The
lease").

### Release on stop

`InboxLeaseReleaser.releaseOnStop(lease)` hands back an update whose handler a stopping node did
not finish, so another node claims it at once rather than after the lease: one claimed and never
handed to its handler, or one whose handler a stopped outbox wait rejected
(`OutboxResultWaiterStopped`, see "Error classes"). It is `InboxStore.retry()` with no delay and the
error `InboxNodeStopped` of class `transient`: the update goes back to `pending`, the group to
`ready` with the ready notification of every retry (see "Ready notifications"), the lease ends, and
a stale token is fenced as in every completion (see "Completions"). The release does what
`OutboxLeaseReleaser` does for the outbox ([`outbox.md`](./outbox.md), "Release on stop").

The release writes the attempt, and it counts towards `INBOX_MAX_ATTEMPTS`, although the limit is
not checked on it: a stop says nothing about the update, so it neither blocks the group nor waits a
retry delay. The handler may have replied before the stop, so the update may be handled twice (see
"The lease"). The next transient failure of an update released on its last attempt blocks the
group, and the retry delay of a later transient failure grows with the attempt.

The handler must have settled before the release: the group is `ready` at once, and a handler
still running could reply after another node has handled the next update of the group.
`InboxUpdateProcessor` releases only an update whose handler has not started or has thrown (see "The
update processor").

**Under `Application` the release of a stopped wait is waited for.** A handler the runner left
running in a wait for the outbox ends with `OutboxResultWaiterStopped` once `Application` stops the
result waiter, after `OutboxRunner.stop()` ([`application.md`](./application.md), "Stop", step 4):
earlier, the waiter would reject handlers whose replies the outbox is still about to send. Its
release is a write, so `Application` then awaits `InboxRunner.waitForHandlersLeftRunning()`, which
resolves once every handler `stop()` left running has settled and its update is released or has its
outcome written, and only then closes the pool. A closed pool refuses the release with
`CONNECTION_ENDED`, and the update would stay `processing` until the recovery of its lease, up to
`INBOX_LEASE_DURATION` later. The wait has no deadline of its own and lives on the overall one
(`GRACEFUL_SHUTDOWN_TIMEOUT`): a handler that neither ends nor waits for the outbox holds the stop
to it, and past it the update waits for the recovery as before.

## Cleanup

Two methods of the store keep the tables from growing without bound. Each deletes one batch of at
most `INBOX_CLEANUP_BATCH_SIZE` rows in one statement and returns how many it deleted, so a caller
that gets a full batch calls again. `InboxMaintenance` calls them on timers (see "Maintenance").

- `deleteFinishedUpdates()` deletes the `done` updates whose `finished_at` is older than
  `INBOX_DONE_RETENTION`, and the `skipped` ones older than `INBOX_SKIPPED_RETENTION`. A `failed`
  update is never deleted: it waits for a person. An update without `finished_at` is not deleted
  either, so whatever sets `skipped` sets `finished_at` too. The row of a `done` or a `skipped`
  update is what turns a redelivered update away (see "Push", step 2): Telegram redelivers within
  24 h, so neither `INBOX_DONE_RETENTION` nor `INBOX_SKIPPED_RETENTION` may be less than a day, and
  the config rejects a shorter one (`INBOX_RETENTION_RANGE` of `ConfigValuesBuilder`). The filter
  bounds `finished_at` alone, `finished_at < now() - retention`, so that
  `telegram_inbox_finished_at_idx` serves it (see "Tables"), as the filter of the outbox cleanup
  does ([`outbox.md`](./outbox.md), "Cleanup"): `finished_at` plus the retention, compared with
  `now()`, would leave the index aside. The config takes a retention up to
  `Number.MAX_SAFE_INTEGER` ms (`INBOX_RETENTION_RANGE`), and `now()` minus one that reaches past
  4713 BC, the earliest timestamp PostgreSQL has, fails out of range: the cleanup then fails on
  every run, and its error is in the log. The batch is locked
  `FOR UPDATE SKIP LOCKED`: the lock rechecks the status on the newest version of the row, so an
  update a person has moved back to `pending` meanwhile is kept, and two nodes cleaning at once
  take different rows.
- `deleteIdleGroups()` deletes the `idle` groups. It locks them `FOR UPDATE SKIP LOCKED`: a group a
  push or a completion holds is left to them, and the lock rechecks the state on the newest version
  of the row, so a group a push has made `ready` meanwhile is left alone too. A push that waits for
  a group the removal holds inserts the group again, because the push takes the group row in the
  statement that inserts it (see "Push", step 1). Unlike the outbox chat, a group has no limit to
  keep: an `idle` group has no `next_attempt_at` in the future, so every `idle` group goes. The
  updates of a removed group stay; a late completion of one of them is fenced (see "Completions").
  A removed group may still hold a `failed` update that did not block it: putting it back by hand
  needs the group row again.

## The polling source

`InboxPollingSource` takes the updates from Telegram by long polling and pushes them into the inbox.
`start()` runs its loop and throws when called a second time; `stop()` ends it. A failure the loop
does not expect ends the polling with a `critical` log, not an unhandled rejection.

One process polls. Telegram answers a second `getUpdates` of the same bot with 409, and nothing
keeps two polling processes apart: running several is not a goal now
([#828](https://github.com/yuldashevsardor/telegram-bot/issues/828)).

The loop is the source's own, over `getUpdates` of a grammY `Api` of its own, made by
`TelegramApiFactory` without the transformers of the bot and with a timeout of the long poll and a
margin. `bot.start()` and the fetcher of a grammY runner move the offset
themselves, on receipt or after their own handling, hand the updates out one at a time, and either
drop a batch whose handling failed or stop polling for good; neither retries the same batch.

1. `deleteWebhook`: Telegram gives no `getUpdates` while a webhook is set. Then `getMe`: the
   group of an update is read off a grammY `Context`, which takes the bot. A failure of either is
   logged, and both are tried again after a pause (below).
2. `getUpdates` with the offset, `ALLOWED_UPDATES` of `bot.types.ts` and the limits read off the
   constants of the source. The first offset is 0, below every `update_id`: Telegram answers it
   from the first update it has not been told of.
3. Each update gets its group, `from` and `chat` of the `Context`, the pair `getSessionKey()`
   makes the session key of, whatever the type of the update. An update without either is dropped
   (see "Updates without a session key"); `hasSessionKey()` of `session.helper.ts` is the rule of
   both.
4. `pushBatch()` of the rest. Only once it has committed does the offset move past the last update
   of the answer, dropped ones included: the next `getUpdates` tells Telegram that the bot has
   them.

A failed `getUpdates` or push is logged and tried again from the same offset after a pause, so
Telegram gives the same batch again, and the push leaves out what it stored already (see "Push",
step 2). The pause is the retry delay the outbox and the inbox share, `RetryDelay.computeMs()` of
the failures in a row, of calls and pushes alike ([`outbox.md`](./outbox.md), "Retry delay"), so an
outage, a revoked token (401) or a webhook or another poller (409) is not retried and logged every
second; a 429 of a Bot API call waits its `retry_after` when that is longer, up to the longest
delay of a Node timer, some 24.8 days. A failed push waits the retry delay alone: it never reaches
the Bot API classifier. A stored batch and a passed preparation
start the count over. The error of a Bot API call is logged as it is thrown: the fetch error an
`HttpError` wraps names the URL of the call, and the URL carries the bot token, so the token can
reach the log: the owner's decision in
[PR #839](https://github.com/yuldashevsardor/telegram-bot/pull/839).

A restart gets no duplicate into the inbox. The first offset of every start is 0, and Telegram
answers it from the first update it has not been told of; an update is told of by a `getUpdates`
whose offset is past it, and never comes again. So only the last batch before the stop comes again,
and the push leaves out its updates stored already, while their rows are kept: the retention of a
`done` or a `skipped` update is at least the 24 h Telegram keeps an update (see "Cleanup").

**A refused update.** PostgreSQL refuses a `\u0000` escape or a lone surrogate in `jsonb`, and
`pushBatch()` stores the batch in one statement, so one such update rolls the batch back, and
every retry from the same offset would fail on it again. Whether Telegram ever sends either is
unverified. The store tells a refusal and throws `InboxUpdateRefused` of `inbox-store.errors.ts`:
a failure with the SQLSTATE PostgreSQL gives either value, `22P05` for the escape and `22P02` for
the surrogate, of a push whose updates hold such a value in a string or a key, by
`isJsonbStorable()` of `telegram/jsonb-string.ts`, the rule the payload codec of the outbox refuses
a payload by. The code alone is not enough: `22P02` is the code of any malformed input, and a change
of the store that broke every row would give it too. Any other error of PostgreSQL in a push is
`InboxPushFailed`, the parent class of the refusal. Both carry the code, message and detail of the
error, not the error itself: the CONTEXT PostgreSQL gives a refused value holds the update up to
that value, the text of the message included. A failure that is no error of PostgreSQL, a dropped
connection, goes through as it is. The source pushes a refused batch one update at a time, and an
update refused again is dropped with an error log. Any other failure, of the batch or of a single
push, leaves the offset where it was, another data exception of class `22` included, and its error
log names the updates not stored. `test/telegram/inbox/inbox-store.spec.ts` pins both codes and
both classes. The store is out of mutation testing (see "The store in code").

**The stop** aborts the Bot API call in flight, ends the pause at once and waits for a push in
flight, and no `getUpdates` follows; nor does the next single push of a refused batch. A push that
fails after the stop is logged as a warning, not an error: no retry follows, the next start gets
its updates again. It has no deadline of its own: a push stuck on the database
holds it, so the stop of the application waits for it no longer than `INBOX_POLLING_STOP_TIMEOUT`
([`application.md`](./application.md), "Stop").

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL besides one rule that needs no database, the refusal of a push (see "The polling
source"), so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its spec is in
`DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing"). No mutant tests that rule:
only the database specs of the store pin it.

`InboxFailureHandler` and `InboxLeaseReleaser` are there too: their specs run them over the real
store, so that each outcome is pinned by the rows it leaves rather than by the calls a fake store
records. The decisions of `InboxFailureHandler` are a `switch` over the class and the count of
attempts. The classes themselves are in `InboxFailureClassifier`, which needs no database and is
mutated.

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

The updates go to the database as JSON text cast to `jsonb`, not through `sql.json()`; why is in
the comment of `insertBatch()`, which `pushBatch()` calls.

## Testing

`test/telegram/inbox/inbox-end-to-end.spec.ts` runs the whole chain but the webhook: an update
pushed into `telegram_inbox` with `InboxStore.pushBatch()`, where the webhook will push it, reaches
the handler of the bot, and what the handler sends reaches a fake Bot API through the outbox. The
spec takes everything from the `Container` of the application, on the database of the run, with
the config `fillApplicationContext()` builds from the `DATABASE_*` variables of the environment, the
`CONFIG` of the spec and the defaults, so a setting of a developer's `.env` does not reach it:
`InboxRunner` with its source and processor, `Bot` with its filters, middleware,
session and conversation, the outbox transformer on `bot.api`, the result waiter and `OutboxRunner`.
It rebinds two tokens: `Tokens.Bot.ApiFactory` to point the outbox at the fake Bot API, and
`Tokens.Bot.Session.Storage` to the real `PgsqlStorage` behind a wrapper whose reads of a chosen
session throw first. Neither maintenance nor the polling source is started.

The fake Bot API is `FakeBotApi` of `test/telegram/fake-bot-api.helper.ts`, shared with the
end-to-end spec of the outbox, which says how it takes and records a call
([`outbox.md`](./outbox.md), "The end-to-end spec"). `TelegramAnswers` of the spec answers the calls
as Telegram does; which methods it knows is read off its `resultOf()`. It can also hold the replies
to the chats it is given until a reply to each of them has come, which is how the spec sees the
handlers of two groups run at the same time. grammY takes the API root of an `Api` only when it
builds one, and `Bot` builds its own from the token alone, so the spec points the two Apis at the
server in two ways. The `Api` the outbox sends with comes from `TelegramApiFactory`, rebound to
`FakeBotApiFactory` of the helper. The calls of the bot's own `Api` that bypass the outbox, `getMe`
of `init()` and `setMyCommands` of `setup()`, go through a transformer installed before `setup()`,
under the outbox one, which sends them to the server with `fetch`.
Another transformer, installed after `setup()` and so the outermost one, records what each call of
a handler resolves to: the spec compares the result of `ctx.reply()` with the message the server
sent.

A handler fails through the session, not through the fake Bot API: the wrapper throws an error with
the code `ECONNRESET`, which `InboxFailureClassifier` takes for a lost database connection, a
transient failure. Through the outbox no answer of the Bot API gives a handler a transient failure
whose retry can pass. A 5xx reaches the handler only once the outbox has failed the message on its
last attempt, and that blocks the outbox chat; the retried update replies into the blocked chat, and
its wait ends with `OutboxResultTimeout`, an `Unexpected` failure that blocks the group whatever
attempts are left (see "Error classes").

Not covered here: the webhook, the polling source (`inbox-polling-source.spec.ts`), two nodes and
the lease handover (`inbox-runner.database.spec.ts`, with a stub handler), the stop, a failure the
outbox gives the handler, and the conversion of a real font.

## Load test

How the store holds up on 100 M updates, measured, and what the measurements propose:
[`inbox-load-test.md`](./inbox-load-test.md).
