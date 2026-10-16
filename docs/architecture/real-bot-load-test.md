# Real bot load test

The outbox and the inbox run against the real Telegram: one run of `/bulk_messages` on a development
bot, on 2026-10-11, watched by its logs. The load tests of the stores
([`outbox-load-test.md`](./outbox-load-test.md), [`inbox-load-test.md`](./inbox-load-test.md))
measure the SQL on large tables, and the end-to-end specs replace Telegram with a fake server
([`outbox.md`](./outbox.md), "The end-to-end spec"); this run measures what neither does: the limits
of Telegram itself, how the limits and the pause of the outbox meet them, and a reply of the bot
while a bulk send is queued. The times are UTC.

## How it was run

- One node, `make up` in a worktree of `main` at `81e1aa96`, on the shared database of the
  worktrees with nothing else on it, and the bot token of the worktree's slot.
- `/bulk_messages` pushed 10 000 `sendMessage` calls of 1 000 random characters into its three
  chats in turn, 3 333 – 3 334 a chat (`bulk-messages.command.ts`). All three are private chats of
  the owner's accounts.
- The `.env.dist` defaults, `LIMIT_COMMON_NUMBER=30` and `OUTBOX_CONCURRENCY=5` among them, but for
  the private chat limit, changed between the phases below with a restart of the container. The
  pause of the outbox lives in the database, so a restart kept it.
- The logs were followed for the status line of `OutboxMaintenance` and the warning of a 429 that
  `OutboxFailureHandler` writes. The numbers below are read from the rows, the `attempts` of
  `telegram_outbox`, each with its `started_at`, `finished_at` and `error`, and from
  `pg_stat_user_tables` and `docker stats`. No target makes them.
- The owner's laptop, Docker Desktop, on battery. Nothing kept it awake, and it slept twice during
  the last phase (see "Sleep of the laptop").

## The private chat limit of Telegram

| phase | `LIMIT_PRIVATE_NUMBER`, `LIMIT_PRIVATE_INTERVAL` | messages a second, 3 chats | 429 |
|---|---|---|---|
| A, 20:44 – 21:04 | 3, 1000 (`.env.dist`) | 8.2 – 8.8 | 4, `retry_after` 267 s each |
| B, 21:04 – 21:09 | 1, 1000 | 3.0 | 1, `retry_after` 200 s |
| C, from 21:09 | 1, 3100 | 1.0 | none in some 40 minutes awake, 740 – 749 messages a chat |

Every 429 came on the 101st message of a chat since the end of the previous pause: in phase A 34 s
after the sending resumed, in phase B 100 s after, each chat having taken exactly 100 messages
from 21:04:26 to 21:06:06. The `retry_after` made the 300 s up: 34 + 267 and 100 + 200. So for a
private chat Telegram counts some 100 messages in a window of 5 minutes, not a rate: at one
message a second it answers 429 as at three. Phase C, a message every 3.1 s, some 97 in 5 minutes,
passed some 40 minutes awake without one. One bot, one day, texts of 1 000 random characters:
whether the count is the same for another bot or for short replies is not measured. The Bot FAQ of
Telegram speaks of one message a second in a chat.

## The limits of the outbox against it

The chat limit is a cooldown, `interval / number` from one pull of a chat to the next
([`outbox.md`](./outbox.md), "Limits"), and the outbox kept it to within 1%. The gap between two
sends to one chat, from the `started_at` of their attempts:

| phase | cooldown, ms | median, ms | 5th percentile, ms | minimum, ms |
|---|---|---|---|---|
| A | 333 | 340 | 336 | 334 |
| B | 1 000 | 1 008 | 1 004 | 1 002 |
| C | 3 100 | 3 110 | 3 104 | 3 101 |

A cooldown cannot express the window of Telegram. The defaults of `.env.dist`, 3 a second, get a
429 at the 101st message of a chat. A cooldown below the count of Telegram, 3 s and over, gets
none, but it spaces every message of a chat by 3 s, a reply of several messages included, where
Telegram would take 100 at once.

The common limit was not reached: three chats give at most 9 messages a second against its 30.

## The pause after a 429

`OutboxFailureHandler` pauses the outbox for the `retry_after` of a 429 with `OutboxStore.pause()`,
on the one row of `telegram_bot_limits` that every pull of every node reads
([`outbox.md`](./outbox.md), "Limits", the pause). A 429 of one private chat stopped the sending to
all three: 267 s four times in phase A and 200 s in phase B, some 21 of the first 25 minutes of
the run. A reply to any other chat would have waited as long.

## A reply behind the bulk messages

At 20:55:12, during the second pause, the third chat sent `/start`. Its reply, message 10005, went
into the outbox behind some 3 100 bulk messages of the same chat: the priority of a message orders
the chats, not the messages of a chat ([`bot.md`](./bot.md), "Commands"). At 20:56:12 the wait of
the handler ended with `OutboxResultTimeout` after `OUTBOX_RESULT_TIMEOUT`, 60 s, then an
`Unexpected` failure that blocked the group, and the `/bulk_messages` the chat sent next waited
behind the blocked group until the end of the run. At 22:20 the reply
was still `pending`, with 2 094 bulk messages of the chat before it: at a message every 3.1 s,
some 1.8 hours.

Either cause alone was enough: a pause longer than `OUTBOX_RESULT_TIMEOUT` blocked the group of
every update whose reply waited for it, in any chat, and so did a queue of bulk messages longer
than 60 s of the chat limit in the chat of the reply. The timeout is now a `ReplyTimeout` failure,
which fails the update and leaves its group unblocked ([`inbox.md`](./inbox.md), "Error classes").

## Sleep of the laptop

The laptop slept from 21:35 to 21:50 and from 21:51 to 22:07 (`pmset -g log`): the status line
has gaps of 926 and 957 s. The calls in flight failed with `ECONNRESET`, the leases of their chats,
`OUTBOX_LEASE_DURATION` of 90 s, had passed by the clock of the database, and the recovery put
their 5 messages back to `pending` with a transient attempt ("The lease of the chat passed …",
[`outbox.md`](./outbox.md), "Lease recovery"). The completions of the calls that failed came after
it and were fenced: 5 warnings "Outbox completion with a stale lock token changed nothing" of
`OutboxStore`. All 5 were sent again and are `done`; whether a call that failed with `ECONNRESET`
had reached Telegram is not known, so up to 5 of them may have come twice. No message was lost.

## The load on the process and the database

Telegram answered `sendMessage` in a median of 137 – 139 ms in every phase, 190 – 224 ms at the
95th percentile; the longest took 1.5 s in phase B, and 16 minutes in phase C, a call the sleep
cut. In phase C the application took some 2% of a CPU and 131 MB, PostgreSQL some 3% and 75 MB,
over 5 connections; the other phases were not measured so. `/bulk_messages` pushed its 10 000 rows
within the 0.5 s of its update.

Not measured: the time of each statement of the store, which nothing logs, with
`pg_stat_statements` not installed; a load past 9 messages a second; several nodes.

## Along the way

- **A chat that has not started the bot.** The third chat had not sent `/start` to this bot
  before the run: each of its messages failed alone with "Bad Request: chat not found", an
  `Undeliverable` failure that does not block the chat, 299 of them until the chat sent `/start`.
  Nothing deletes a `failed` row ([`outbox.md`](./outbox.md), "Cleanup").
- **The long poll.** `getUpdates` failed with `ECONNRESET` 3 times in 1.5 hours and once at each
  wake-up, and the polling source took it again from the same offset each time
  ([`inbox.md`](./inbox.md), "The polling source").
- **The conversation of `/start`.** The first `/bulk_messages` of the run, sent right after
  `/start`, was taken by the conversation, which waits for the next update of the chat and echoes
  its text ([`bot.md`](./bot.md), "Commands"); the second one pushed the messages.

## Verdict

The outbox keeps its limits to within 1% and loses nothing over a node that stops for 15 minutes,
at a load the process and the database barely notice. What does not hold is the model of the
limits against Telegram: a private chat takes some 100 messages in 5 minutes, which the default of
3 a second exceeds within 34 s, and which a cooldown can meet only by spacing every message by
3 s. Each 429 then pauses the whole bot for up to 4.5 minutes, and a reply that waits longer than
60 s, behind that pause or behind the bulk messages of its own chat, blocks the inbox group of its
user until a person unblocks it.
