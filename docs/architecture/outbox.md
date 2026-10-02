# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
any node sends them, the order inside a chat holds across nodes, and a node that dies loses
nothing (the plan is epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)).
No caller or sending loop uses the directory yet: so far it holds the tables with `OutboxStore`
(`store/outbox-store.ts`), which pushes, pulls within the limits, pauses, completes a pulled
message, finds the expired leases and cleans up, `OutboxMessageSource` (`outbox-message-source.ts`),
which hands the pulled messages to the worker loop of the node, `OutboxMessageProcessor`
(`outbox-message-processor.ts`), which takes one pulled message to its outcome, with
`OutboxSender`, which makes its Bot API call, `OutboxFailureHandler` (`outbox-failure-handler.ts`),
which picks the outcome of a failed send, recovers the expired leases and releases a lease on stop,
`OutboxResultWaiter`, which waits for the outcome of a message, with `OutboxFinishedMessageReader`,
the payload codec and the retry delay. The error classes of a failed call lie outside it, in
`telegram/bot-api-failure-classifier/`.

## Tables

One migration, `1790546834232_telegram-outbox-tables.ts`, creates the three tables with every
column the outbox needs. The columns and what they mean are in its `createTable` calls and
`comment`s; the comment of `next_attempt_at` is replaced by
`1790666223510_telegram-outbox-chat-limit-comment.ts` and then, with that of `status`, by
`1790682156623_telegram-outbox-retry-comments.ts`; those of `attempts` and `lock_token` are
replaced by `1790716587328_telegram-outbox-attempt-worker-comment.ts`. There are no indexes
besides the primary keys yet: they will be picked once the queries of every stage are settled.

The database does not check the values of `status` and `state`: the store writes them only
through the `OutboxStatus` and `OutboxChatState` enums (`store/outbox-store.types.ts`). Of these,
nothing sets `skipped` yet.
`telegram_bot_limits` holds one row, `id = 1`, inserted by the migration; nothing but the code
keeps it single. Without the row `pull()` and `pause()` throw `BotLimitsRowMissing`: the pull
would otherwise answer as if no chat were ready, and the pause would change nothing.

The **head** of a chat is its first message by `id` among the active statuses (`pending`,
`processing`). The priority of a chat is the priority of its head, read from the head itself when
needed: the chat row keeps no copy.

A `failed` message is not active. The status says what happened to the message, the state of the
chat says whether the chat waits: a failed message that blocks its chat holds it through `blocked`,
and one that does not block lets the next message of the chat become the head. To unblock a chat
by hand, its failed message goes back to `pending`, and its `id` makes it the head again, or goes
to `skipped` ([#631](https://github.com/yuldashevsardor/telegram-bot/issues/631)). A failed message
that did not block its chat goes out again only if its chat is made `ready` too, and its chat row
is inserted first if the cleanup has removed it: the chat of such a message may be `idle`, and no
pull reaches a message without a `ready` chat row (see "Cleanup").

## Chat states

| state | who sets it |
|---|---|
| `idle` | `push` of a new chat, for the moment before its messages are inserted; `markAsDone` and `markAsFailed` of the last active message |
| `ready` | `push` into an `idle` chat; `markAsDone` and `markAsFailed` when a message is left; `retry` |
| `processing` | `pull` |
| `blocked` | `markAsFailedAndBlockChat`; `push` leaves it as it is |

An `idle` chat whose `next_attempt_at` has passed loses its row to `deleteIdleChats()` (see
"Cleanup"); the next `push` inserts it again as a new chat.

## The chat lock

The chat row is the lock of its chat. `push` and every completion lock the rows of their chats
first and read what their change depends on — the chat state, the active messages left — in a
later statement of the same transaction ([invariant](./invariants.md)). Under `read committed` every
statement reads a fresh snapshot, so a statement that runs after the lock sees what the previous
holder of the lock committed. A single statement reads its snapshot before it waits for the lock.
A completion written that way leaves a chat `idle` with a message pushed meanwhile: a message that
is never sent. A push written that way takes its ids before the lock, and two pushes of one chat
can commit in the order opposite to their ids: the later message is sent first.

So a push and a completion of one chat are serialized in either order: the one that locks second
sees what the first committed. `test/telegram/outbox/outbox-store.spec.ts` lines the calls up
behind a lock held by a third client and pins both orders, and the ids of a push taken after its
lock.

A push that inserts the chat row locks it in the same statement: an `idle` chat can be deleted by
the cleanup at any moment, and a push that inserted the row with `ON CONFLICT DO NOTHING` and
locked it in the next statement would find it gone and put its messages in without a chat, where
no pull reaches them. The spec has the removal take the chat while a push waits for it.

`pull` is the exception: it locks and reads the head in one statement, see below.

## Push

`push()` is `pushBatch()` of one message. The batch is a transaction:

1. every chat of the batch is inserted `idle` or, if it has a row, locked: one statement,
   `ON CONFLICT DO UPDATE … WHERE false` (see "The chat lock"). PostgreSQL locks the conflicting
   row before it checks the condition, so the row is locked, and the false condition writes no new
   version of it. The rows go in `chat_id` order, so two batches lock the chats they share in the
   same order;
2. the messages go in as one `jsonb` array and are inserted `ORDER BY` their position in it, so
   the ids grow in the order of the input;
3. every `idle` chat of the batch becomes `ready`; a chat in any other state already has an older
   head;
4. `pg_notify` on `telegram_outbox_ready` with an empty payload, delivered on commit, so that an
   idle sender wakes up at once. `OutboxMessageSource` listens on it once the worker loop asks it
   for a message (see "The message source").

## Pull

`pull(limit, worker)` throws `InvalidPullLimit` on a `limit` that is not a whole number from 1 to
`Number.MAX_SAFE_INTEGER`. Otherwise it is one statement, atomic without a transaction:

1. the bot row, `FOR UPDATE`, if a chat is ready to be pulled: another pull or a `pause()` holding
   the row is waited for. The time of the pull (`pulled_at` in the SQL) is the moment it holds the
   row, `clock_timestamp()` after the lock, and `now()` when it did not lock the row. If the pause
   of the row as locked is over and its `next_send_at` has passed by then, it gives the budget of
   the pull (see "Limits"); a pause, a spent common limit or nothing to pull means a budget of zero.
   A pull with nothing to take does not lock the row, so it does not hold back a pull that has;
2. up to the budget of `ready` chats whose `next_attempt_at` has passed by the time of the pull,
   with the head of each (`CROSS JOIN LATERAL`), by the priority of the head, then by
   `next_attempt_at`, then by `chat_id`, `FOR UPDATE OF chats SKIP LOCKED`: a chat another puller
   holds is skipped, not waited for;
3. the head goes to `processing`, but only if it is still `pending`; its `attempts` stay as they
   are, the completion writes the attempt (see "Completions");
4. the chats whose head was pulled go to `processing`, `next_attempt_at` moves to the time of the
   pull plus the chat limit, and the chat is leased to the pull (see "The lease");
5. `next_send_at` of the bot moves by the messages pulled;
6. the answer: the pulled messages, by priority, then by `id`, so a caller that sends them in
   order sends the urgent first, each with the `lockToken` of the pull, `startedAt` (the time of the
   pull), the `worker` passed to the pull and `earlierAttempts`, the length of its `attempts`; and
   `nextPullInMs`, when the next pull can give out a message.

Step 4 is what serves the chats of one priority in turn: a chat just served goes behind the chats
that waited. The chats of one kind — private or group — in one pull get the same
`next_attempt_at`, so `chat_id` decides their next turn. Only one head per chat is taken, and a
`processing` chat is not `ready`, so a chat never has two messages in `processing`.

Step 2 reads the head from the snapshot of the statement, taken before the lock. A chat completed
and made `ready` again after the snapshot still passes the lock (the lock rereads the newest row
version), while the head read with it is the old one, already `done` by then. The check of step 3
turns that head away: the chat is left `ready` for the next pull instead of sending the head twice.
The chat takes a slot of `limit` and gives nothing, and it keeps its `next_attempt_at`, but only
for this pull: the head of a `ready` chat is `pending` (a `failed` message is not a head), so the
next pull, with a fresh snapshot, takes it. The window is narrow as well: another pull must have
started at least a chat limit before this one, and its completion must have committed between the
start of this statement and its lock of the chat. That gap holds the wait for the bot row as well:
microseconds without it, the length of the statements queued ahead under load.

The lock of step 1 makes the pulls of all the nodes take turns: two pulls that read the same
`next_send_at` would both spend it. A pull that finds the row locked waits for the other pull, which
holds it for one statement, and both the budget and the bot's time in the answer come from the row
as the lock found it: `pull()` reads `next_send_at` and `paused_until` from the `bot` CTE that
locks it, and from the snapshot only when it did not lock the row. Under `read committed` the
statement that waited reads every other table from the snapshot taken before the wait, while the
lock returns the newest version of the row and rechecks the `WHERE` of the locking query on it. So
that `WHERE` holds nothing another pull or a pause changes: a row turned away by the recheck would
leave the answer to the snapshot, where the row was still due, and the answer would be zero instead
of the `next_send_at` the other pull left.

The limits, the due chats, the lease and `startedAt` go by the time of the pull, not by `now()`,
which is the start of the statement, before the wait. Counted from `now()`, the pulls queued behind
a pull slower than the common cooldown would each find the slot the one before them moved already
due, and all of them would go out when the slow pull commits. A chat that came due during the wait
would be left out while the budget counts the slots due after it, and a pull with a slot to spend
would answer zero. `test/telegram/outbox/outbox-store.spec.ts` holds a pull, and a pause, open in a
transaction while other pulls wait, and pins what they pull and answer.

The wait makes no lock cycle: only `pull()` and `pause()` lock the bot row, each in one statement
that takes the row before any other lock, so a statement waiting for the row holds nothing another
could wait for ([invariant](./invariants.md)). `pause()` locks nothing else; `pull()` locks its
chats in step 2, whose budget needs the row, and its message rows in step 3, after them. Holding
the row, a pull skips a locked chat but waits for a locked message row, so a transaction that held
a message while it waited for the bot row would close a cycle with it.

A pull that skips a due chat held by another transaction, an open push or completion of that chat,
gets no messages: with nothing pulled, the bot's time decides the answer (see "Limits"), zero once
`next_send_at` has passed, and a caller that pulls again at once spins until that transaction
commits. The message source sleeps on such an answer instead (see "The message source").

## Limits

The limits are `limits.*` of the configuration (`TelegramLimits`), the same values the in-memory
queue takes ([`outbound-queue.md`](./outbound-queue.md)). A limit of `number` messages per
`interval` ms spaces the messages by its cooldown, `interval / number`.

- **The chat limit.** A pull moves `next_attempt_at` of a chat to the time of the pull (see "Pull")
  plus the cooldown of the group limit for a negative `chat_id` and of the private one otherwise
  (the rule of `isGroupChat()`, written in the SQL). A chat is not pulled before that. A chat that
  goes `idle` and gets a new message keeps the time, so an idle spell does not shorten it. The
  cooldown counts from the pull, not from the send: a head that waits after the pull spends the
  cooldown of its chat, so the caller sends right after the pull.
- **The common limit.** The slots of the bot come due one per cooldown from `next_send_at`, up to
  `number` of them for a bot that has sent nothing for a while. The budget of a pull is the slots
  due at the time of the pull, capped by `limit`. The pull moves `next_send_at` to that time plus
  one cooldown per message it pulled: the slots it did not use are dropped, and a batch of the whole
  `number` holds the next one back for the whole `interval`. So no window of `interval` gets more
  than `number` messages, as with the in-memory queue. Counted from the slots saved up instead, a
  burst of `number` would be followed by a slot every cooldown: nearly twice the limit in one
  interval. The cooldown counts from the pull, not from the slot, and `nextPullInMs` rounds it up to
  a whole millisecond, so both the rounding and the latency of the caller come off the rate. With a
  limit of 30 per 1000 ms the answer is 34 ms, and a caller that pulls 3 ms after it sends a message
  every 37 ms: about 10% under the limit. What the message source adds to that is in "The message
  source".
- **The pause.** `pause(durationMs)` sets `paused_until` to `now()` plus the duration, never
  earlier than it is (`greatest`): a 429 that asks for less than the pause left changes nothing.
  The pause stops the pull on every node, since every pull reads the same row. It moves
  `next_send_at` to its end as well, so the slots come due from there one by one: the first pull
  after a 429 gets one message, not a burst of `number`. A duration that is negative, `NaN` or
  above `Number.MAX_SAFE_INTEGER` throws `InvalidPauseDuration`: an infinite pause would never end,
  and `greatest` would keep it, while `1e17` ms overflows the interval PostgreSQL adds to `now()`.
  The pause counts from `now()` of its statement, before its wait for the bot row behind the pulls
  queued on it, so it ends early by that wait: milliseconds against a `retry_after` of seconds.

`nextPullInMs` is the later of the nearest `next_attempt_at` among the `ready` chats not pulled by
this pull and the bot's own time — `next_send_at` after the pull, or `paused_until` if later —
counted from the time of the pull and never below zero. It is `null` when no chat is `ready`: there
is no time to wait for. A push or a completion brings a message then, but another node hears only of
a push and of a release on stop, the two that notify `telegram_outbox_ready` (see "Release on
stop"). A ready chat left out by `limit` or skipped as locked no longer holds the answer back: the
bot's time decides it, the cooldowns the pull has just spent, or zero if it pulled nothing.

The answer is not capped. A long pause or a long interval of a limit, common or chat, gives more
than a Node timer takes (`ConfigParser.MAX_TIMER_DELAY`; what Node does with more is in
[`config.md`](./config.md)), so a caller that sleeps on the answer caps it first, as the message
source does.

The times are the database's (`now()`, `clock_timestamp()`), and so is the answer: a duration
counted from the pull, not a moment. The rule is in [`invariants.md`](./invariants.md), "The
outbox".

## The message source

`OutboxMessageSource` (`outbox-message-source.ts`) is what the worker loop of a node takes the
pulled messages from. `stream(worker)` makes the one async generator of the node. The loop sends
several messages at once, each in a slot of its own
([#747](https://github.com/yuldashevsardor/telegram-bot/issues/747)), and awaits the next message
of the generator whenever a slot is free: the slots are the loop's, the source knows nothing of
them. The `worker` passed in names the loop, not a slot, and
goes into every attempt the generator pulls. The source serves one generator: it keeps one sleep in
progress, and a second generator is checked by nothing ([`invariants.md`](./invariants.md), "The
outbox"). Nothing makes the generator yet: the worker loop is
[#728](https://github.com/yuldashevsardor/telegram-bot/issues/728).

- **One message per pull.** The generator pulls with a `limit` of 1, and only when the loop asks
  for the next message, so the loop never holds a leased message it has not started on.
- **The sleep.** A pull that got nothing puts the generator to sleep for `nextPullInMs`, capped by a
  random point from 100 ms to 1 s (`MIN_SLEEP_CAP_MS`, `MAX_SLEEP_CAP_MS`), drawn for each sleep.
  A `null` answer sleeps the whole cap, and so does zero: with nothing pulled, zero means that
  another transaction holds a due chat (see "Pull"), and pulling again at once would spin until it
  commits. The cap keeps the sleep within a Node timer as well (see "Limits"). A completion that
  leaves its chat `ready` notifies no one, so the next message of that chat waits for a sleep of at
  most the cap. The cap is random so that the nodes that sleep the whole cap together, as the ones
  that skipped the same held chat do, wake up apart.
- **The wake-up.** The generator starts `LISTEN` on `telegram_outbox_ready`
  (`OutboxStore.listenReady()`) at its start, on the listening connection of the client
  ([`storage.md`](./storage.md), "LISTEN"). A failed start is logged at `warning` and is not
  repeated, for the reason given in "Waiting for the result": postgres.js subscribes the listener
  again when its listening connection closes. Until the listening starts, the generator goes on
  with the capped sleep. A start that fails after the stop is not logged: a clean shutdown may
  close the database under it. A notification wakes the sleeping generator, and so does every
  start of the listening: a push committed while the connection was down reached no one. A
  notification that comes while the generator pulls makes it pull again instead of sleeping: the
  pull may have read the tables before the push committed.
- **A failed pull** is logged at `error`, and the generator sleeps the whole cap and pulls again:
  the source ends only on stop. No notification cuts that sleep short, nor one that came during
  the failed pull: pushes go on while the pulls fail (a missing `telegram_bot_limits` row fails
  every pull, not a push), and the generator would retry and log at their rate. A pull that fails
  after the stop is logged at `warning` and ends the generator: the database may have been closed
  under it.
- **The stop.** `stop()` ends the generator: a sleeping one at once, one whose pull is in progress
  once it has handed out what the pull got, so no pulled message is left leased to nobody, and one
  waiting for the loop at its next message. A generator made after the stop ends without a pull
  and does not start the listening: the database may be closed by then, and a `LISTEN` would open
  a connection that nothing closes. The loop sends the messages it holds: waiting for the calls in
  flight is the loop's.

What this costs the rate of the common limit (see "Limits"):

- A pull of one message drops the other slots due of the bot (see "Limits", the common limit), so
  a loop whose slots were all busy through a long call gets one message once a slot frees, not the
  bot's slots due meanwhile. The limit is reached only while the loops of all the nodes together
  pull at least once per cooldown.
- The latency of the loop comes off the rate as "Limits" counts it: how late its timer fires, and
  the time from the answer of one pull to the start of the next.
- The pulls of all the nodes take the bot row in turn while a chat is ready to be pulled, even
  while the common limit is spent or the bot is paused: a pull locks the row before it learns
  either. A check of the snapshot before the lock would spare them the row, since `next_send_at`
  and `paused_until` only move forward, but it would be a condition the lock does not recheck, and
  no measurement asks for it yet.

What it costs the database: the wait for the bot row has no bound. A transaction left open on the
row, such as an `UPDATE telegram_bot_limits` by hand in `psql`, stops the pull of every node, and
each waiting pull holds a connection of the pool meanwhile. During a pause, or while the common
limit is spent, a push cannot make a pull succeed, yet its notification wakes the sleeping generator
of every node, and one that comes during a pull makes the generator pull again. While the pushes
come faster than a pull takes, each generator pulls at their rate and gets nothing until the pause
or the cooldown is over. The source cannot tell such a time apart: `pull()` answers with a duration,
not with its reason.

## The lease

A pull leases each chat it pulled: `locked_until` is the time of the pull plus `leaseDurationMs`
(`OUTBOX_LEASE_DURATION`), and `lock_token` is the token of the pull, a `randomUUID()` the code
makes before the statement and returns with every message as `lockToken`. One token for the chats of
a pull is enough: the fence compares the token of one chat row, and a chat is leased to one pull at
a time, so the token only has to tell that pull from the next pull of the same chat. The completion
ends the lease: both columns go back to `NULL`. A lease that passes before the completion is
recovered (see "Lease recovery"). How long the lease must be is in
[`invariants.md`](./invariants.md), "The outbox".

The delivery is at least once. A node that dies after Telegram took the call and before its
completion commits leaves the message `processing`; once the lease is recovered, the message goes
out again. The Bot API has no idempotency key, so the outbox cannot tell such a send from a failed
one.

## Completions

A leased message is completed by one of the public methods of the store that take an
`OutboxLease`: the message given out by `pull()`, or an expired lease read by `findExpiredLeases()`
(see "Lease recovery"). What each does to the message and the chat
is read off its body. Each is a transaction through the private `complete()`:

1. lock the chat row of the message; a missing message throws `OutboxMessageNotLeased`;
2. the fence: a `lockToken` that is not the chat's changes nothing and is logged as a warning, with
   the error the completion carried. The lease has passed to another pull, or an earlier
   completion of the same pull has ended it. A message whose chat row is missing changes nothing
   either and is logged with a warning of its own: the cleanup removed the chat once it went
   `idle`, and an `idle` chat holds no lease;
3. the message leaves `processing`. A message that is not `processing` under the chat's own token
   is another message of the chat, and the method throws `OutboxMessageNotLeased`;
4. the chat state, and the end of the lease.

A completion into `done` or `failed` goes through the private `finishMessage()`, which also sends
`pg_notify` of the id on `telegram_outbox_finished` in the same transaction (see "Waiting for the
result").

Step 3 appends the attempt to `attempts`, whole: `started_at` and `worker` from the lease, the
error, `null` for `done`, and `finished_at` of `now()`. Both times are the database's. Nothing is
written into `attempts` before the completion, so a node that dies while it sends leaves no trace
of the attempt; the recovery of its lease appends one (see "Lease recovery").

A retried message stays the head of its chat, so its chat waits with it: the messages behind it
are not pulled before it, while the other chats are.

Every update of the store sets `updated_at` itself, to `now()`, and the pull to the time of the
pull; there is no trigger.

## Waiting for the result

The node that pushes a message waits for its outcome, while any node may send it.
`OutboxResultWaiter.wait(messageId)` (`result-waiter/outbox-result-waiter.ts`) resolves with the
message once it is `done`, `failed` or `skipped`: its id, status and `response`. A failed message
resolves too: the caller reads the status.

- **The notification.** A transaction that moves a message into one of those statuses sends
  `pg_notify` on `telegram_outbox_finished` with the message id as the payload
  ([invariant](./invariants.md)). The id alone: NOTIFY carries at most 8000 bytes, less than a
  Telegram response can take. Every listening node hears every id; the waiter reads the row of an
  id it waits for with `OutboxFinishedMessageReader.find()` (`outbox-finished-message-reader.ts`)
  and ignores the rest. PostgreSQL delivers a notification on commit, so the row read on it has the
  outcome. The store sends it with `pg_notify` through the `sql` of the transaction, not with
  `sql.notify()` of postgres.js: that one runs on the pool whatever `sql` it is called on
  (`notify()` in its `src/index.js`), so inside a transaction it would notify before the commit,
  and even for a transaction that rolls back. No spec pins this: `pg_notify` is the last statement
  before the commit, and nothing outside the store can hold the transaction open between them.
- **The listening** starts once, with the first wait, through `sql.listen()` on a connection of
  its own ([`storage.md`](./storage.md), "LISTEN"). A failed start is logged at `warning` and is
  not repeated: postgres.js keeps the listener of a failed `LISTEN` and subscribes it again when
  its listening connection closes, so a second call would add a second listener, and every
  notification would be read twice (`listen()` in postgres.js `src/index.js`).
- **The poll.** A notification sent while the listening connection is down, or before it is up,
  reaches no one. So one `find()` query looks up every id waited for: every
  `OUTBOX_RESULT_POLL_INTERVAL` ms while any is waited for, and each time the listening starts,
  the first time and after postgres.js opens the connection again. A tick that comes while the
  previous poll still runs is skipped. A start of the listening is not: the running poll may have
  read the table before the `LISTEN`, so a new poll follows it. A failed lookup is logged at
  `warning` and left to the next poll.
- **A message finished before its wait.** Its notification finds no one waiting for its id, so the
  first poll finds it, up to `OUTBOX_RESULT_POLL_INTERVAL` ms late. The caller waits right after
  `push()` returns, while the message still has to be pulled and sent, so the window is narrow, and
  no lookup is spent on every wait to close it.
- **The timeout.** A wait rejects with `OutboxResultTimeout` after `OUTBOX_RESULT_TIMEOUT` ms and
  the id is forgotten: a later notification or poll leaves it alone. The message stays in the outbox
  and may still be sent.

A second wait for an id still waited for gets the same promise.

`stop()` rejects every pending wait with `OutboxResultWaiterStopped` and clears the timers: a node
that shuts down neither polls its closed database nor is held up by a wait until its timeout.
`Container.close()` calls it before it closes the database, which ends the listening.

The waiter does not depend on the store: it takes `OutboxFinishedMessageReader`, which only reads.
So the waiter has no SQL: mutation testing reaches it through a fake reader, and
`outbox-finished-message-reader.spec.ts` runs it over the real one.

## Cleanup

Two methods of the store keep the tables from growing without bound. Each deletes one batch of at
most `OUTBOX_CLEANUP_BATCH_SIZE` rows in one statement and returns how many it deleted, so a caller
that gets a full batch calls again. Nothing calls them yet: the timers are the sending loop's
([#624](https://github.com/yuldashevsardor/telegram-bot/issues/624)).

- `deleteFinishedMessages()` deletes the `done` messages whose `finished_at` is older than
  `OUTBOX_DONE_RETENTION`, and the `skipped` ones older than `OUTBOX_SKIPPED_RETENTION`. A `failed`
  message is never deleted: it waits for a person to unblock its chat or look at it. A message
  without `finished_at` is not deleted either, so whatever sets `skipped` sets `finished_at` too.
  The retention is added to `finished_at` rather than taken off `now()`: the config takes a
  retention up to `Number.MAX_SAFE_INTEGER` ms (`CLEANUP_RANGE` of `ConfigValuesBuilder`), and
  `now()` minus that falls below 4713 BC, the earliest timestamp PostgreSQL has. The batch is
  locked `FOR UPDATE SKIP LOCKED`: the lock rechecks the status on the newest version of the row,
  so a message a person has moved back to `pending` meanwhile is kept, and two nodes cleaning at
  once take different rows.
- `deleteIdleChats()` deletes the `idle` chats whose `next_attempt_at` has passed. It locks them
  `FOR UPDATE SKIP LOCKED`: a chat a push or a completion holds is left to them, and the lock
  rechecks the state on the newest version of the row, so a chat a push has made `ready` meanwhile
  is left alone too. A push that waits for a chat the removal holds inserts the chat again (see
  "The chat lock"). A chat whose limit has not passed keeps its row: a push recreates the chat with
  `next_attempt_at` of `now()`, so a removed row would let the next message out before the limit.
  The messages of a removed chat stay; a late completion of one of them is fenced (see
  "Completions"). A removed chat may still hold a `failed` message that did not block it: putting
  it back by hand needs the chat row again (see "Tables").

How the retention must relate to the wait for a result and to the lease is in
[`invariants.md`](./invariants.md), "The outbox".

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

## Sending

Two classes send a pulled message, so that the sending loop only hands it over and Telegram is
called from one place:

- `OutboxMessageProcessor.process(message)` (`outbox-message-processor.ts`) takes the message to
  its outcome: it rebuilds the payload with `deserialize()`, has the sender call the method, and
  completes the message (below). Nothing calls it yet: the sending loop that will is
  [#624](https://github.com/yuldashevsardor/telegram-bot/issues/624);
- `OutboxSender.send(method, payload)` (`outbox-sender.ts`) makes the call: the method by its name,
  with the payload alone. It resolves with Telegram's result and throws the error of the call as
  grammY throws it; it knows neither the store nor the files.

The processor completes the message:

- the call answers: `markAsDone()` with Telegram's result as the `response`;
- the call throws, or the row does not rebuild (`InvalidFileMarker`, a corrupted row):
  `OutboxFailureHandler.handle()` with the error as it was thrown (see "Outcomes"). A wrapped
  `GrammyError` would bring the copy of the call into the attempt: the serializer leaves out the
  payload of a `GrammyError` only at the top level.

The sender calls through an `Api` of its own, from `OutboxApiFactory`
(`outbox-api-factory.ts`): the bot token, no transformers, and `timeoutSeconds` from
`OUTBOX_API_TIMEOUT`; why is in the comment of `create()`. A call that runs past the timeout fails
with an `HttpError`, a transient failure (see "Error classes").

The files of a message, every `PathFile` of its payload, are removed once `markAsDone()` has made
it `done`, and only then:

- a failed message keeps them: a person may put it back to `pending` by hand (see "Tables"), and
  without its file it would fail at once and block its chat again (see "Error classes"). A failed
  message is never deleted either (see "Cleanup"), so nothing removes its files;
- a retried message keeps them for its next attempt;
- a fenced completion keeps them: `markAsDone()` returns `false` when it changed nothing (see
  "Completions"). Another completion has changed the message already: the recovery of its lease
  put it back to `pending`, for a pull that sends it again, or failed it on its last attempt (see
  "Lease recovery"), or another node finished it and the cleanup removed its chat. Either way the
  files are not this completion's to remove;
- a send the node did not finish, a node that died or a database that went away, keeps them for the
  node that recovers the lease (see "Lease recovery").

A file that cannot be removed is logged as a warning and the next one is removed: the message is
sent either way. What removing the file after the send asks of the caller is in
[`invariants.md`](./invariants.md), "The outbox".

## Failures

The decisions that need no database are classes without SQL, so mutation testing reaches them.
`OutboxMessageProcessor` calls `OutboxFailureHandler.handle()` (see "Sending").

### Error classes

`TelegramBotApiFailureClassifier.classify(error)`
(`telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.ts`) sorts a failed Bot
API call into the `TelegramBotApiFailureKind` values: the four classes of the epic
([#618](https://github.com/yuldashevsardor/telegram-bot/issues/618), "Error classes") and
`Unauthorized`, which the epic does not have. Which error falls into which class is read off the
branches of the method. What the code does not say is why the boundaries are drawn where they are,
and why one failure is not classified at all:

- Every 403 is `Undeliverable`, not only the bot blocked or kicked: a 403 is Telegram refusing the
  bot this chat, and a retry does not change that.
- A 400 is `Undeliverable` only by its exact description or by `migrate_to_chat_id` in its
  `parameters`, because 400 is also the code of a malformed call, which is a bug and must block the
  chat. A description Telegram rewords falls to `Unexpected` and blocks the chat: the safe side. A
  group upgraded to a supergroup takes no messages under its old id, and the message is not resent
  to the new one.
- A 401 is `Unauthorized`: the token has been revoked, and every call of the bot fails the same way
  until the process is restarted with a new one. As `Unexpected` it would block every chat the
  outbox tries, each to be unblocked by hand, so the outbox pauses instead (see "Outcomes"). A 404
  is not `Unauthorized` although Telegram answers it to a token of a wrong format as well as to an
  unknown method: such a token fails the `getMe` the runner calls when the bot starts
  (`bot.init()`), so a 404 while the bot runs is an unknown method, a bug of the call, and it is
  `Unexpected`.
- An `HttpError` is `Transient` although grammY throws it also after Telegram may have taken the
  call: its own timeout, a connection reset while the answer is on its way. The retry can deliver
  the message twice. The delivery is at least once anyway (see "The lease"), and a duplicate costs
  less than a lost message or a blocked chat.
- The exception is a file that is gone, the file of a `PathFile`: `Unexpected` at once, since every
  retry would look for the same missing file. The sign is `ENOENT` of `open` on the error of the
  file stream, which grammY passes on inside the `HttpError` as it is (`isMissingFile()`). The
  code alone is not enough: node-fetch copies it from a network error, a resolver's `ENOENT`
  included, but not the syscall. Any other file-system error stays `Transient`: out of descriptors
  (`EMFILE`) or a hiccup of shared storage (`EIO`) may pass on a retry.
- A lost database connection is not a Bot API error and is not classified here: the outcome of
  such a send cannot be written anyway. The recovery of an expired lease takes such a message back
  (see "Lease recovery").

### Outcomes

`OutboxFailureHandler.handle(message, error)` (`outbox-failure-handler.ts`) classifies the error
and completes the message by its class; which completion each class gets is read off the branches
of `applyOutcome()` and `retryOrBlock()`. The error goes into the attempt as
`OutboxErrorSerializer` (`outbox-error-serializer.ts`) writes it, with its class in `kind`; what the
serializer leaves out and why is in the comment of `serialize()`.

An `Unauthorized` failure pauses the outbox as a flood does, for `UNAUTHORIZED_PAUSE_SECONDS`, and
returns the message to `pending`: sending resumes by itself once the pause is over and no node with
the old token is left. During a rolling restart a node still on the old token that wins a pull
after a pause gets a 401 and pauses the outbox for every node, the restarted ones included, so
sending stops and starts until the last node is restarted. Why the pause is that long is in the
comment of the constant. No chat is blocked, so the handler logs the 401 as an error itself.

Its attempt counts as a flood's does, but a token outage is not bounded as a `retry_after` is. The
counts of probes below rest on two premises: the caller sleeps on `nextPullInMs`, and the set of
waiting chats stays the same through the outage. Such a caller pulls within one common cooldown of
the end of the pause, so the first pull after each pause takes one message (see "Limits"), the head
of the most urgent priority first (see "Pull", step 2), so a less urgent head is pulled only when no
more urgent chat can be: `ready`, its `next_attempt_at` passed and not locked. A pull that comes
later has a budget of more than one (`floor((pulled_at - next_send_at) / cooldown) + 1`) and takes
the next heads as well, less urgent ones included, and each of them collects a probe per pause. The
retry keeps the `next_attempt_at` its chat got from that pull, unless the 401 came back later than
the chat limit, so the probes go round the waiting chats within the most urgent waiting priority. A
pause can carry more than one probe: a pull that another puller makes while the 401 is still on its
way, the loop of another node or of the same one, finds the probed chat `processing` and takes the
next head that can be pulled, a less urgent one included. A head of the most urgent waiting priority
that shares it with other waiting chats collects `OUTBOX_MAX_ATTEMPTS` probes in about as many
pauses times the number of those chats; a less urgent head gets only such stray probes, if any. A
chat that starts waiting during the outage joins the round and lengthens it: a new chat's
`next_attempt_at` is the time of its push, and an idle one keeps its old one (see "Limits"), so
either can be ordered ahead of the probed heads. A lone head of the most urgent priority, a reply to
a user among bulk messages, gets one probe per pause and collects them in about
`OUTBOX_MAX_ATTEMPTS` pauses: the most urgent chat pays first.

A head with `OUTBOX_MAX_ATTEMPTS - 1` attempts or more, those before the outage included, blocks its
chat on its first transient failure, with no retry. That can happen during the outage as well: a
probe answered by an `HttpError` instead of a 401 goes through `retryOrBlock()`, and so does the
lease of a node that died mid-probe once it is recovered. After the last node is restarted, every
such head is a transient failure away from the block. That is accepted: a revoked token is an
incident fixed by hand anyway, the chats it leaves blocked are unblocked in the same pass, and
leaving a 401 out of the count would move a count by `kind` into the SQL of `pull()`.

Every attempt counts towards `OUTBOX_MAX_ATTEMPTS`, a flood included: the attempt being handled is
`earlierAttempts + 1`. The limit is checked on a transient failure only, so a flood never blocks a
chat by itself, but the floods before a transient failure bring its block nearer and lengthen its
retry delay, which grows with the same number: after five floods the first transient failure waits
16 to 32 s instead of 0.5 to 1 s, at the `.env.dist` defaults of `OUTBOX_RETRY_FIRST_DELAY`,
`OUTBOX_RETRY_MAX_DELAY` and `OUTBOX_RETRY_DELAY_MULTIPLIER`. The count covers the whole history of
the message: a message that blocked its chat and was put back to `pending` by hand blocks the chat
again on its next transient failure, with no retry.

A `retry_after` that `pause()` refuses (see "Limits") throws out of `handle()` before the retry,
and the message stays `processing` until its lease is recovered.

### Lease recovery

`OutboxFailureHandler.recoverExpiredLeases()` takes back the messages of the chats whose lease has
passed: the node that pulled them is presumed dead. The sending loop is to call it on a timer.

1. `OutboxStore.findExpiredLeases()` reads every chat whose `locked_until` is behind `now()`, with
   its `processing` message, as a lease under the chat's own `lock_token`. It reads without a lock
   and leaves the lease as it is.
2. Each lease is a transient failure, completed as one: the message goes back to `pending` with the
   retry delay of its attempt, or, on the last attempt of `OUTBOX_MAX_ATTEMPTS`, fails and blocks
   its chat (see "Outcomes"). The completion appends an attempt with the error `OutboxLeaseExpired`
   of class `transient`. The leases are completed one after another, and a completion that throws
   ends the call: the leases after it wait for the next one.

The recovery completes the message as the node that pulled it would: through the same fenced
completions, under the token of that pull (see "Completions"). So whichever comes first, the
recovery or the late completion of the node presumed dead, changes the message, and the other one
is fenced off and logged as a stale lock token, or as a removed chat if the cleanup has deleted
the chat once it went `idle`. So is a second recovery of the same lease by
another node that read it before the first recovery committed: the read claims nothing, so with
several nodes recovering at once, one expired lease can give each of the others such a warning.
The fence checks the token, not `locked_until`, so a lease that has passed must never be extended
([`invariants.md`](./invariants.md), "The outbox").

The appended attempt has `worker: null`: the pull keeps the worker nowhere but in the answer it
gave out. Its `started_at` is `locked_until` minus `OUTBOX_LEASE_DURATION`, in the form the pull
gives out `startedAt` (the form of a timestamp inside `jsonb`). That is the time of the pull only
while the duration has not changed since: a node restarted with another duration shifts the start
by the difference.

The message goes out again, although the node may have died after Telegram took the call: the
delivery is at least once (see "The lease").

### Release on stop

`OutboxFailureHandler.releaseOnStop(lease)` hands back a message whose call a stopping node did not
finish, so another node takes it on its next pull rather than after the lease. It is
`OutboxStore.retry()` with no delay and the error `OutboxNodeStopped` of class `transient`: the
message goes back to `pending`, the chat to `ready` with the chat limit the pull set, the lease
ends, and a stale token is fenced as in every completion (see "Completions").

The release passes `shouldWakeIdleNodes` to `retry()`, which then sends `pg_notify` on
`telegram_outbox_ready` in its transaction, delivered on commit as the one of a push; a fenced
release sends none. The node that would pull the message next is the one that stops, and a
node whose last pull found nothing `ready` got `nextPullInMs` of `null`: no time to wait for, only a
notification (see "Limits"). Without it the message could wait for an unrelated push longer than the
lease the release exists to cut short.

The caller releases a call only once it has settled: aborted and its promise done. The chat is
`ready` at once, so another node may send the message and the next one behind it while a call of the
stopping node is still on its way, and Telegram would show the message again after the next one.
The lease keeps that order only while it outlasts the call (see "The lease"), and the release ends
it early. An aborted call may still have reached Telegram before the abort: that is the duplicate
below, not a change of order.

The call may have reached Telegram, so the release writes the attempt and it counts towards
`OUTBOX_MAX_ATTEMPTS` (see "Outcomes"), although the limit is not checked on it: a stop says nothing
about the message, so it neither blocks the chat nor waits a retry delay. The next transient failure
of a message released on its last attempt blocks the chat, and the retry delay of a later transient
failure grows with the attempt as well (see "Retry delay"). The handler cannot tell a call in flight
from a message pulled and never sent, so each gets the attempt: a message a node pulls and hands
back on every rolling stop comes nearer to the block and to a longer delay each time.

### Retry delay

`OutboxRetryDelay.computeMs()` (`retry-delay/outbox-retry-delay.ts`) is how long a message waits
before its retry after a transient failure. The step, its cap, the jitter and why the jitter takes
the upper half of the step are in the comment above the method. The first step, the cap and the
multiplier come from the `OUTBOX_RETRY_` variables of `.env.dist`.

## The payload rule

A row outlives the process that wrote it and is sent by whichever node claims it, so only what
another node can rebuild enters the outbox. `serialize(method, payload)`
(`payload-codec/payload-codec.ts`) takes only what it knows how to store and throws on anything
else, so no part of the payload reaches the row unchecked:

- strings, numbers, booleans, `null` and `undefined` pass to JSON. An `undefined` field is left
  out of the row. A `null` field stays in it, and grammY drops it when the row is sent, as it does
  when it sends the call itself (`str()` and `payloadToMultipartItr()` in grammY's
  `core/payload.js`). A `NaN`, `Infinity` or `-Infinity` field is written as `null`, so it is left
  out of the sent call too. Arrays and plain objects are walked;
- a function becomes `undefined`, which JSON writes as it writes any `undefined` (a field left
  out, `null` in an array): `InlineQueryResultBuilder` returns plain objects that keep its builder
  methods (`.text()`, `.location()`) as fields (`inputMessageMethods()` in grammY's
  `convenience/inline_query.js`);
- grammY's `InlineKeyboard` and `Keyboard` are walked as plain objects: they are classes with data
  fields only, which JSON writes as they are. Of the classes grammY exports, they are the only
  ones meant for a payload besides `InputFile`: `InputMediaBuilder` and `InlineQueryResultBuilder`
  build plain objects (`convenience/input_media.js`, `convenience/inline_query.js`);
- a `PathFile` (`new PathFile(path, filename?)`, `telegram/path-file/path-file.ts`, a subclass of
  `InputFile`) becomes the marker `{ "$pathFile": { "path", "filename" } }`; `deserialize()`
  rebuilds it as a `PathFile`. The marker is the stored format: a change of its key leaves the rows
  already written unreadable. A marker `serialize()` would not write is a corrupted row and throws
  `InvalidFileMarker` (the conditions are in `readMarker()`);
- any other `InputFile` inside a payload throws `UnsupportedInputFile`: a `Buffer`, a stream or a
  supplier function lives only in the memory of this process. The check is by class, so a file
  grammY has already sent is rejected too, although grammY has replaced its `toJSON()` with one
  returning `attach://<id>` (`collectFiles()` in grammY's `core/payload.js`);
- an object that already carries the marker key throws `ReservedFileKey`: `deserialize()` would
  read it as a file;
- a string or a key that PostgreSQL does not accept in `jsonb` throws `UnstorableString`: U+0000
  or a lone UTF-16 surrogate (a caption cut through an emoji). The path and the file name of a
  `PathFile` are checked too;
- any other value throws `UnsupportedValue`: another class instance, a `Date`, an object without
  a prototype, a `bigint`, a symbol. A payload grammY builds holds none of them. A payload of
  plain objects that refers back to itself is not caught: the walk overflows the stack with a
  `RangeError`;
- a payload that is not a plain object throws `UnsupportedValue` before the walk: an array, an
  `InputFile`, a keyboard or a function is never a Bot API payload itself, although the walk takes
  an array, a `PathFile` and a keyboard inside one and drops a function there. `undefined` throws
  too, although a transformer gets it for a raw call without arguments to a method that has
  parameters (`api.raw.getUpdates()`; `api.getUpdates()` passes `{}`, `core/api.js`): grammY's
  `ApiClient` swaps it for `{}` only after the transformers (`core/client.js`), so a caller in a
  transformer passes `{}` in its place.

An error of `serialize()` names the method and where the value sits in the payload
(`media.1.thumbnail`), in the message and in `payload`.

grammY keeps the source of an `InputFile` private, so `PathFile` keeps the path in a public
field of its own. That is why a path passed to `new InputFile()` is rejected too: the codec cannot
read it.

The node that sends the row reads the file at the stored path. The rules this puts on the path are
in [`invariants.md`](./invariants.md), "The outbox".
