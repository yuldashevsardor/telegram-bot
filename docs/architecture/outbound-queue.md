# Outbound queue (TaskQueue / Partition / Runner)

Throttles outgoing Telegram calls. The mechanism itself works with tasks under an arbitrary
key and asks the `LimitResolver` interface for the limit of a key; the only Telegram-specific
place in it is `telegram-error.ts` with the codes by which `Runner` recognises a 429. The
implementation of `LimitResolver` lies outside the directory —
`telegram/telegram-limit-resolver.ts`, which picks the group or the private limit by
`isGroupChat` from `telegram/telegram-chat.ts` (a negative chat ID is a group). Why the
interface and its implementation lie apart is in [`README.md`](./README.md).

The queue serves Telegram alone — hence its place, `telegram/outbound-queue/`: there are two
consumers, both of them Telegram (`TelegramCallApiMiddleware` and `BulkMessagesCommand`,
[`bot.md`](./bot.md)), and the limits arrive as `TelegramLimits` with the keys `common`,
`private` and `group` ([`config.md`](./config.md)), whose defaults are Telegram's
recommendations (`ConfigValuesBuilder.build`, mirrored by `.env.dist` under `### Limits`).

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
                       sleep in [RUNNER_SLEEP_INTERVAL_MIN, ..._MAX], why — below
```

- **`TaskQueue`**: key → partition, the priority index `keysByPriority` (a `Set` keeps
  insertion order) and `idleKeys`; on top of them — the common `RateLimit` and the pause
  mark, which give two of the three `null`s of step 1. The order is not strict FIFO: a key
  under its limit is skipped. A key that has given out a task leaves the `Set` and comes back
  at its tail while its bucket still holds tasks; otherwise, at the default limits, only the
  first ten keys would ever be served. The priority is global.
- **`Partition`**: three buckets by priority, FIFO inside a bucket; its own `RateLimit`.
- **`RateLimit`**: a single slot with a cooldown of `interval / number`, not a token bucket.
  `reserve()` on a busy slot throws `RateLimitIsBusy`. `number = 0` gives an infinite
  cooldown, which is why the config takes `LIMIT_*_NUMBER` from 1 up.
- **The life of a partition**: it is removed once it is empty and has cooled down. The queue
  sees the emptiness right after `take()`, in `pullByPriority`, and puts the key into
  `idleKeys`; the cooldown is checked by the next `pull()`, the walk stops at the first
  partition still cooling, and no more than `REMOVED_PARTITIONS_PER_PULL` (100) go per call.
  Removing on emptiness alone is not allowed: while the cooldown lasts, the partition is the
  limit of the key.
- **Errors**: `Runner.handleTask` catches a rejected `callback` and calls two methods:
  `handleError` writes an `error` and on a 429 sets `TaskQueue.ban()`, `retryTask` returns
  the task with its `priorityOnError`, raising its `retryCount`; there are exactly
  `RUNNER_MAX_RETRIES` retries, after which the task is dropped — but with an `error` in the
  log, not silently. `ban()` counts milliseconds while Telegram sends `retry_after` in
  seconds, so `Runner` multiplies by 1000 (an unreadable `retry_after` →
  `DEFAULT_RETRY_AFTER_SECONDS`): without the multiplier the pause after a 429 would come out
  a thousand times shorter than required. The caller sees the first rejection, not the
  outcome of the retries: otherwise `ctx.reply()` would hang for the whole pause.

The sleep of the loop runs between `RUNNER_SLEEP_INTERVAL_MIN` and `..._MAX`
(`ConfigValuesBuilder.getRunner`, mirrored by `.env.dist` under `### runner`) and is picked
at random on every empty iteration: an even step would hit the same point of the cooldown
window over and over.

## The path of an outgoing call

Any `ctx.api.*` (including `ctx.reply`) during the handling of an update goes like this:

1. A grammY `Api` method builds the payload and calls `ctx.api.raw[method](payload, signal)`
   (a method without parameters — `raw[method](signal)`); `raw` carries a `Proxy` from
   `TelegramCallApiMiddleware` ([`bot.md`](./bot.md)), which gives out `callApi`.
2. `callApi` either calls the saved `originRaw` directly (the bypass conditions are in
   [`bot.md`](./bot.md)), or creates a Promise, builds the `callback`, puts the task into the
   queue and hands the Promise to the caller — that is, the caller gets it before the call
   has been made, and waits for as long as the task lies in the queue.
3. The task is given out by the next `pull()` of the `Runner.handleTasks` loop (the scheme
   above), and `handleTask` does `await task.callback()`.
4. `callback` waits for the real call and settles the Promise: on success —
   `messageResolve`, on a rejection — `messageReject` and a rethrow. Both sides need the
   rejection: the caller — as the rejection of `ctx.reply()`, the queue — as the entry into
   "Errors" above. Without the `await` inside `callback` an unfinished promise would go out,
   and the queue would not see the rejection from Telegram. A retry takes the same
   `callback`, so a successful second attempt does send the message to the user, but no
   longer changes the already rejected Promise.
5. From there the chain breaks off: no handler answers the user about a delivery failure —
   the rejection ends in a log ([`bot.md`](./bot.md)).
