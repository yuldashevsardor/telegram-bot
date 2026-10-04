# Outbound queue (TaskQueue / Partition / Runner)

Throttles outgoing Telegram calls. The mechanism works with tasks under an arbitrary key and asks
the `LimitResolver` interface for the limit of a key. Its only Telegram-specific file is
`telegram-error.ts`: the codes by which `Runner` recognises a 429.

`LimitResolver` is implemented outside the directory, in `telegram/telegram-limit-resolver.ts`. It
picks the group or the private limit by `isGroupChat` from `telegram/telegram-chat.ts`: a negative
chat ID is a group. Why the interface and its implementation lie apart is in
[`README.md`](./README.md).

Nothing pushes into the queue any more: the calls of the bot and `/bulk_messages` go through the
outbox ([`outbox.md`](./outbox.md), [`bot.md`](./bot.md), "The outbox transformer"), while
`Application` still starts and stops its `Runner` ([`application.md`](./application.md)).

The queue lies in `telegram/outbound-queue/` because it serves Telegram alone:

- The limits arrive as `TelegramLimits` with the keys `common`, `private` and `group`
  ([`config.md`](./config.md)). Their defaults are Telegram's recommendations
  (`ConfigValuesBuilder.build`, mirrored by `.env.dist` under `### Limits`).

```
push(task, priority) → the Partition of the key (created on its first task; the limit of the
                       key is asked of LimitResolver once) + the keysByPriority index
pull()               → 0. drop from the head of idleKeys the partitions that are empty and
                          have cooled down
                       1. null on the pause after a 429, on an empty queue or on a busy
                          common limit
                       2. HIGH → MEDIUM → LOW; inside a priority — the first key whose limit
                          has cooled down
                       3. Partition.take() gives out the head of the bucket and reserves the
                          limit of the key, TaskQueue reserves the common limit
Runner               → a setTimeout loop: pull(), run the callback without waiting for it,
                       next iteration through setTimeout(0); on an empty pull — a random
                       sleep in [RUNNER_SLEEP_INTERVAL_MIN, ..._MAX] (why — "The sleep of the
                       loop")
```

- **`TaskQueue`** holds key → partition, the priority index `keysByPriority` and `idleKeys`. On
  top of them sit the common `RateLimit` and the pause mark. These two give two of the three
  `null`s of step 1.
- **The order is not strict FIFO**: a key under its limit is skipped. The priority is global.
- **A key that has given out a task leaves its `Set`.** It comes back at the tail while its bucket
  still holds tasks (a `Set` keeps insertion order). Without that move, at the default limits
  only the first ten keys would ever be served.
- **`Partition`** has three buckets by priority, FIFO inside a bucket, and its own `RateLimit`.
- **`RateLimit`** is a single slot with a cooldown of `interval / number`, not a token bucket.
  `reserve()` on a busy slot throws `RateLimitIsBusy`. `number = 0` gives an infinite cooldown,
  so the config takes `LIMIT_*_NUMBER` from 1 up.
- **A partition is removed once it is empty and has cooled down.** Emptiness alone is not
  enough: while the cooldown lasts, the partition is the limit of the key. The queue sees the
  emptiness right after `take()`, in `pullByPriority`, and puts the key into `idleKeys`. The
  next `pull()` checks the cooldown. That walk stops at the first partition still cooling and
  removes at most `REMOVED_PARTITIONS_PER_PULL` (100) per call.

## Errors

`Runner.handleTask` catches a rejected `callback` and calls `handleError` and `retryTask`.

- `handleError` writes an `error`. On a 429 it also pauses the whole queue with `TaskQueue.ban()`.
- `Runner` multiplies `retry_after` by 1000: `ban()` counts milliseconds, while Telegram sends
  `retry_after` in seconds. Without the multiplier the pause after a 429 would be a thousand
  times shorter than required. An unreadable `retry_after` is replaced by
  `DEFAULT_RETRY_AFTER_SECONDS`.
- `retryTask` puts the task back with its `priorityOnError` and raises its `retryCount`.
- A task gets exactly `RUNNER_MAX_RETRIES` retries. Then it is dropped, with an `error` in the
  log rather than silently.

## The sleep of the loop

The sleep is picked at random on every empty iteration, between `RUNNER_SLEEP_INTERVAL_MIN` and
`..._MAX`. An even step would hit the same point of the cooldown window over and over. The bounds
are read in `ConfigValuesBuilder.getRunner`, mirrored by `.env.dist` under `### runner`.
