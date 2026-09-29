# Outbox (telegram/outbox/)

The outbox is being built to replace the in-memory outbound queue
([`outbound-queue.md`](./outbound-queue.md)): outgoing Bot API calls become rows in PostgreSQL,
any node sends them, the order inside a chat holds across nodes, and a node that dies loses
nothing (the plan is epic [#618](https://github.com/yuldashevsardor/telegram-bot/issues/618)).
No sender or caller uses the directory yet: so far it holds the tables with `OutboxStore`
(`store/outbox-store.ts`), which pushes, pulls within the limits, pauses, completes a pulled
message and finds the expired leases, `OutboxFailureHandler` (`outbox-failure-handler.ts`), which
picks the outcome of a failed send and recovers the expired leases, `OutboxResultWaiter`, which
waits for the outcome of a message, with `OutboxFinishedMessageReader`, the payload codec and the
retry delay. The error classes of a failed call lie outside it, in
`telegram/bot-api-failure-classifier/`.

## Tables

One migration, `1790546834232_telegram-outbox-tables.ts`, creates the three tables with every
column the outbox needs. The columns and what they mean are in its `createTable` calls and
`comment`s; the comment of `next_attempt_at` is replaced by
`1790666223510_telegram-outbox-chat-limit-comment.ts` and then, with that of `status`, by
`1790682156623_telegram-outbox-retry-comments.ts`; the comment of `attempts` is replaced by
`1790716587328_telegram-outbox-attempt-worker-comment.ts`. There are no indexes besides the primary
keys yet: they will be picked once the queries of every stage are settled.

The database does not check the values of `status` and `state`: the store writes them only
through the `OutboxStatus` and `OutboxChatState` enums (`store/outbox-store.types.ts`). Of these,
nothing sets `skipped` yet, and `done` rows are not deleted yet.
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
to `skipped` ([#631](https://github.com/yuldashevsardor/telegram-bot/issues/631)).

## Chat states

| state | who sets it |
|---|---|
| `idle` | `push` of a new chat, for the moment before its messages are inserted; `markAsDone` and `markAsFailed` of the last active message |
| `ready` | `push` into an `idle` chat; `markAsDone` and `markAsFailed` when a message is left; `retry` |
| `processing` | `pull` |
| `blocked` | `markAsFailedAndBlockChat`; `push` leaves it as it is |

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

`pull` is the exception: it locks and reads the head in one statement, see below.

## Push

`push()` is `pushBatch()` of one message. The batch is a transaction:

1. the chats of the batch that have no row yet are inserted `idle` (`ON CONFLICT DO NOTHING`);
2. every chat of the batch is locked, `SELECT … FOR UPDATE` in `chat_id` order, so two batches
   lock the chats they share in the same order;
3. the messages go in as one `jsonb` array and are inserted `ORDER BY` their position in it, so
   the ids grow in the order of the input;
4. every `idle` chat of the batch becomes `ready`; a chat in any other state already has an older
   head;
5. `pg_notify` on `telegram_outbox_ready` with an empty payload, delivered on commit, so that an
   idle sender wakes up at once. Nothing listens on the channel yet: the sender is not written.

## Pull

`pull(limit, worker)` throws `InvalidPullLimit` on a `limit` that is not a whole number from 1 to
`Number.MAX_SAFE_INTEGER`. Otherwise it is one statement, atomic without a transaction:

1. the bot row, `FOR UPDATE SKIP LOCKED`, if the pause is over, `next_send_at` has passed and a
   chat is ready to be pulled; it gives the budget of the pull (see "Limits"). No row — a pause, a
   spent common limit, nothing to pull or another puller holding the row — means a budget of zero.
   A pull with nothing to take does not lock the row, so it does not hold back a pull that has;
2. up to the budget of `ready` chats whose `next_attempt_at` has passed, with the head of each
   (`CROSS JOIN LATERAL`), by the priority of the head, then by `next_attempt_at`, then by
   `chat_id`, `FOR UPDATE OF chats SKIP LOCKED`: a chat another puller holds is skipped, not
   waited for;
3. the head goes to `processing`, but only if it is still `pending`; its `attempts` stay as they
   are, the completion writes the attempt (see "Completions");
4. the chats whose head was pulled go to `processing`, `next_attempt_at` moves to `now()` plus the
   chat limit, and the chat is leased to the pull (see "The lease");
5. `next_send_at` of the bot moves by the messages pulled;
6. the answer: the pulled messages, by priority, then by `id`, so a caller that sends them in
   order sends the urgent first, each with the `lockToken` of the pull, `startedAt` (`now()` of the
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
start of this statement and its lock.

The lock of step 1 makes the pulls of all the nodes take turns: two pulls that read the same
`next_send_at` would both spend it. The pull that finds the row locked gets no messages and a
`nextPullInMs` from the row as it was before the other pull, often zero: a caller that pulls again
at once spins until the other pull commits.

## Limits

The limits are `limits.*` of the configuration (`TelegramLimits`), the same values the in-memory
queue takes ([`outbound-queue.md`](./outbound-queue.md)). A limit of `number` messages per
`interval` ms spaces the messages by its cooldown, `interval / number`.

- **The chat limit.** A pull moves `next_attempt_at` of a chat to `now()` plus the cooldown of the
  group limit for a negative `chat_id` and of the private one otherwise (the rule of
  `isGroupChat()`, written in the SQL). A chat is not pulled before that. A chat that goes `idle`
  and gets a new message keeps the time, so an idle spell does not shorten it. The cooldown counts
  from the pull, not from the send: a head that waits after the pull spends the cooldown of its
  chat, so the caller sends right after the pull.
- **The common limit.** The slots of the bot come due one per cooldown from `next_send_at`, up to
  `number` of them for a bot that has sent nothing for a while. The budget of a pull is the slots
  due now, capped by `limit`. The pull moves `next_send_at` to `now()` plus one cooldown per
  message it pulled: the slots it did not use are dropped, and a batch of the whole `number` holds
  the next one back for the whole `interval`. So no window of `interval` gets more than `number`
  messages, as with the in-memory queue. Counted from the slots saved up instead, a burst of
  `number` would be followed by a slot every cooldown: nearly twice the limit in one interval.
  The cooldown counts from the pull, not from the slot, and `nextPullInMs` rounds it up to a whole
  millisecond, so both the rounding and the latency of the caller come off the rate. With a limit
  of 30 per 1000 ms the answer is 34 ms, and a caller that pulls 3 ms after it sends a message every
  37 ms: about 10% under the limit.
- **The pause.** `pause(durationMs)` sets `paused_until` to `now()` plus the duration, never
  earlier than it is (`greatest`): a 429 that asks for less than the pause left changes nothing.
  The pause stops the pull on every node, since every pull reads the same row. It moves
  `next_send_at` to its end as well, so the slots come due from there one by one: the first pull
  after a 429 gets one message, not a burst of `number`. A duration that is negative, `NaN` or
  above `Number.MAX_SAFE_INTEGER` throws `InvalidPauseDuration`: an infinite pause would never end,
  and `greatest` would keep it, while `1e17` ms overflows the interval PostgreSQL adds to `now()`.

`nextPullInMs` is the later of the nearest `next_attempt_at` among the `ready` chats not pulled by
this pull and the bot's own time — `next_send_at` after the pull, or `paused_until` if later —
counted from `now()` and never below zero. It is `null` when no chat is `ready`: there is no time
to wait for, only a push or a completion brings a message then. A ready chat left out by `limit`
or skipped as locked no longer holds the answer back: the bot's time decides it, the cooldowns the
pull has just spent, or zero if it pulled nothing.

The answer is not capped. A long pause or a long interval of a limit, common or chat, gives more
than a Node timer takes (`ConfigParser.MAX_TIMER_DELAY`; what Node does with more is in
[`config.md`](./config.md)), so a caller that sleeps on the answer caps it first.

The times are the database's (`now()`), and so is the answer: a duration counted from the pull,
not a moment. The rule is in [`invariants.md`](./invariants.md), "The outbox".

## The lease

A pull leases each chat it pulled: `locked_until` is `now()` plus `leaseDurationMs`
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

A pulled message is completed by one of the four public methods of the store after `pull()`, each
taking the pulled message as its lease (`OutboxLease`). What each does to the message and the chat
is read off its body. Each is a transaction through the private `complete()`:

1. lock the chat row of the message; a missing message throws `OutboxMessageNotLeased`;
2. the fence: a `lockToken` that is not the chat's changes nothing and is logged as a warning, with
   the error the completion carried. The lease has passed to another pull, or an earlier
   completion of the same pull has ended it;
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

Every update of the store sets `updated_at = now()` itself; there is no trigger.

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

## The store in code

The store has no interface of its own: no consumer dictates one yet ([`storage.md`](./storage.md)).
It is SQL through and through, so it is in `DATABASE_ONLY_SOURCES` of `stryker.config.mjs` and its
spec is in `DATABASE_SPECS` ([`testing.md`](./testing.md), "Mutation testing").

The ids come back as numbers: the driver returns `bigint` as a string, and the store converts it,
as `PgSqlUserRepository` does ([`storage.md`](./storage.md), "`User.id`").

## Failures

The decisions that need no database are classes without SQL, so mutation testing reaches them.
Nothing calls `OutboxFailureHandler` yet: the sending loop that will is
[#624](https://github.com/yuldashevsardor/telegram-bot/issues/624).

### Error classes

`TelegramBotApiFailureClassifier.classify(error)`
(`telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.ts`) sorts a failed Bot
API call into the four classes of the epic
([#618](https://github.com/yuldashevsardor/telegram-bot/issues/618), "Error classes"), the
`TelegramBotApiFailureKind` values. Which error falls into which class is read off the branches
of the method. What the code does not say is why two boundaries are drawn where they are, and why
one failure is not classified at all:

- Every 403 is `Undeliverable`, not only the bot blocked or kicked: a 403 is Telegram refusing the
  bot this chat, and a retry does not change that.
- A 400 is `Undeliverable` only by its description, because 400 is also the code of a malformed
  call, which is a bug and must block the chat. A description Telegram rewords falls to
  `Unexpected` and blocks the chat: the safe side.
- A lost database connection is not a Bot API error and is not classified here: the outcome of
  such a send cannot be written anyway. The recovery of an expired lease takes such a message back
  (see "Lease recovery").

### Outcomes

`OutboxFailureHandler.handle(message, error)` (`outbox-failure-handler.ts`) classifies the error
and completes the message by its class; which completion each class gets is read off the branches
of `applyOutcome()` and `retryOrBlock()`. The error goes into the attempt as
`OutboxErrorSerializer` (`outbox-error-serializer.ts`) writes it, with its class in `kind`; what the
serializer leaves out and why is in the comment of `serialize()`.

Every attempt counts towards `OUTBOX_MAX_ATTEMPTS`, a flood included: the attempt being handled is
`earlierAttempts + 1`. The limit is checked on a transient failure only, so a flood never blocks a
chat by itself, but the floods before a transient failure bring its block nearer and lengthen its
retry delay, which grows with the same number: after five floods the first transient failure waits
16 to 32 s instead of 0.5 to 1 s at the defaults. The count covers the whole history of the
message: a message that blocked its chat and was put back to `pending` by hand blocks the chat again
on its next transient failure, with no retry.

A `retry_after` that `pause()` refuses (see "Limits") throws out of `handle()` before the retry,
and the message stays `processing` until its lease is recovered.

### Lease recovery

`OutboxFailureHandler.recoverExpiredLeases()` takes back the messages of the chats whose lease has
passed: the node that pulled them is presumed dead. Nothing calls it yet: the sending loop will, on
a timer ([#624](https://github.com/yuldashevsardor/telegram-bot/issues/624)).

1. `OutboxStore.findExpiredLeases()` reads every chat whose `locked_until` is behind `now()`, with
   its `processing` message, as a lease under the chat's own `lock_token`. It reads without a lock
   and leaves the lease as it is.
2. Each lease is a transient failure, completed as one: the message goes back to `pending` with the
   retry delay of its attempt, or, on the last attempt of `OUTBOX_MAX_ATTEMPTS`, fails and blocks
   its chat (see "Outcomes"). The completion appends an attempt with the error `OutboxLeaseExpired`
   of class `transient`.

The recovery completes the message as the node that pulled it would: through the same fenced
completions, under the token of that pull (see "Completions"). So whichever comes first, the
recovery or the late completion of the node presumed dead, changes the message, and the other one
is fenced off and logged as a stale lock token. So is a second recovery of the same lease by
another node that read it before the first recovery committed. The fence checks the token, not
`locked_until`: a lease that has passed keeps its token until a completion, and it is safe only
while a passed lease is never extended. Nothing extends a lease yet; an extension must keep to
this, or the recovery takes back a message whose node has just extended its lease.

The appended attempt has `worker: null`: the pull keeps the worker nowhere but in the answer it
gave out. Its `started_at` is `locked_until` minus `OUTBOX_LEASE_DURATION`, in the form the pull
gives out `startedAt` (the form of a timestamp inside `jsonb`). That is the start of the pull only
while the duration has not changed since: a node restarted with another duration shifts the start
by the difference.

The message goes out again, although the node may have died after Telegram took the call: the
delivery is at least once (see "The lease").

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
