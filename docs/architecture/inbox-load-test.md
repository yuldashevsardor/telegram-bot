# Inbox load test

The claim, the completion, the lease recovery and the cleanup of the inbox store
([`inbox.md`](./inbox.md)) measured on a large table
([#824](https://github.com/yuldashevsardor/telegram-bot/issues/824)), as the outbox store was
([`outbox-load-test.md`](./outbox-load-test.md)).

## How to run it

The test shares the database, `load-up`, `load-psql` and `load-down` with the outbox load test, and
the way the times and the plans are taken: see "How to run it" there. Its own targets, in this
order: `load-inbox-fill-done` once, then per layout `load-inbox-fill-pending` and
`load-inbox-measure [plans=off]`; `load-inbox-index` builds the candidate head index (see
"Results") over the filled table. The files they run are in `test/load/`. A fill stays valid for 6
days, as the outbox one does.

The measurement calls the real `InboxStore` with the settings of `.env`: 15 `claim(1)`, what the
update source of the worker asks for
([#827](https://github.com/yuldashevsardor/telegram-bot/issues/827)), and 15 `claim(30)`, a batch
of the size of the largest outbox one, since nothing in the inbox sets a batch yet; each is
followed by `markAsDone()` of what it gave out. Then `findExpiredLeases()` twice: with no lease
expired, and with the leases of a batch claimed and left to expire, as after a node died. That
batch is claimed by a store with a lease of 1 s rather than the 10 minutes of
`INBOX_LEASE_DURATION`: the recovery reads a lease the same way whatever its length. Last,
`deleteFinishedUpdates()` down to the call that deletes nothing, and `deleteIdleGroups()`.

## Data

- 100 M `done` updates, 78 GB with the primary key, over the groups 1 to 100 000, each a private
  chat whose user and chat are the same id, each update a font sent as a document. Their
  `update_id` is their number in the fill, so the history comes first by `update_id`. They finished
  within the day before the fill, inside `INBOX_DONE_RETENTION`; the oldest 5 000 finished 8 days
  before it, past it. The fill takes 29 minutes.
- About 1 M `pending` updates in two layouts, every group `ready`: 3 groups × 300 000 ("3 groups")
  and 100 000 groups × 10 ("100 k groups"). Their `update_id` follow the done ones, and the updates
  of one group lie apart from each other in the table.
- The database and the machine of the outbox load test, with the outbox fill of 100 M messages
  beside the inbox one. One process calls the store, with nothing else on the database: how the
  claims of several workers skip the groups the others hold is not measured.

## Threshold

A claim of one update or of a batch is to take at most **10 ms**, and so is a completion: the
threshold of the outbox pull. The claim holds no shared row as the pull holds the bot row (claims
skip the groups others hold), but the update source of #827 claims one update per call, one call
after another, so the time of a claim bounds how many updates one worker loop can start a second:
100 at 10 ms.

## Results

The times are those of the client, in ms, from runs with `plans=off`, except the column without an
index; "first" is the first call of the run, the cold cache.

| call | no index, 3 groups | index, 3 groups | index, 100 k groups |
|---|---|---|---|
| `claim(1)` | 276 136, 301 307 | first 29, then 0.4 – 1.6, median 0.6 | first 397, then 98 – 115, median 101 |
| `claim(30)` | — | 0.5 – 1.8, median 0.6, for 3 updates | 97 – 110, median 102, for 30 updates |
| `markAsDone()` | 73 556, 292 | median 0.7, p95 1.5, max 3.7 | median 0.6, p95 1.2, max 8.1 |
| `findExpiredLeases()`, no lease expired | — | 0.5 | 3.1 |
| `findExpiredLeases()`, a batch expired | — | 1 458, 3 leases | 13, 30 leases |
| `deleteFinishedUpdates()`, a full batch | — | 4.9 – 280, one of 82 549 | — |
| `deleteFinishedUpdates()`, nothing to delete | — | 84 156 | 84 219 |
| `deleteIdleGroups()` | — | 18 | 35 |

Without an index only two claims and their completions were measured, with the plans on: each claim
took minutes, and the rest of the run would have taken hours. The candidate index is
`test/load/inbox-candidate-index.sql`, `telegram_inbox (user_id, chat_id, update_id) WHERE status
IN ('pending', 'processing')`, the counterpart of the head index of the outbox
([`outbox-load-test.md`](./outbox-load-test.md), "Why the index is partial"); built over the filled
table it took 1 minute 39 seconds. The plans add to the time: `claim(1)` of 100 k groups took a
median of 131 ms with them and 101 ms without. The first run with the plans of the 100 k groups
layout had its call of `deleteFinishedUpdates()` that finds nothing cancelled by the statement
timeout of 10 minutes; its rerun took 83 s, as the run without the plans did, and the cause was not
found.

### The head without an index

The claim looks up the head of every ready group before it sorts the groups and takes the first
`limit` of them, and each lookup is a scan of the whole table: 92 s a group, 30 M pages read for
the 3 groups of a `claim(1)`.

```
Nested Loop  (actual time=97553.203..275581.042 rows=3.00 loops=1)
  ->  Seq Scan on telegram_inbox_groups inbox_group  (actual time=0.028..0.075 rows=3.00 loops=1)
        Filter: ((state = 'ready'::text) AND (next_attempt_at <= now()))
  ->  Subquery Scan on head  (actual time=91860.288..91860.290 rows=1.00 loops=3)
        ->  Limit  (actual time=91860.210..91860.211 rows=1.00 loops=3)
              ->  Sort  (actual time=91859.920..91859.920 rows=1.00 loops=3)
                    Sort Key: telegram_inbox.update_id
                    Sort Method: top-N heapsort  Memory: 25kB
                    ->  Seq Scan on telegram_inbox  (actual time=91144.970..91850.243 rows=300000.00 loops=3)
                          Filter: ((status = ANY ('{pending,processing}'::text[])) AND (user_id = inbox_group.user_id) AND (chat_id = inbox_group.chat_id))
                          Rows Removed by Filter: 100600000
                          Buffers: shared hit=38403 read=30169242
```

The completion looks for an active update left in the group (`releaseGroup()`) with a parallel scan
of the table that stops at the first one: 73 s. The second completion took 292 ms only because its
scan started near the active updates, where the first one had stopped (`synchronize_seqscans`, see
[`outbox-load-test.md`](./outbox-load-test.md), "The cleanup").

```
Limit  (actual time=73438.135..73471.571 rows=1.00 loops=1)
  Buffers: shared hit=102 read=10000145 written=2
  ->  Gather  (actual time=73378.605..73412.039 rows=1.00 loops=1)
        ->  Parallel Seq Scan on telegram_inbox  (actual time=73354.085..73354.099 rows=1.00 loops=3)
              Filter: ((status = ANY ('{pending,processing}'::text[])) AND (user_id = '1'::bigint) AND (chat_id = '1'::bigint))
```

### The claim and the completion with the index

Each head is one lookup of the index, its first entry for the group; the completion finds the update
left in the group the same way, and the rest of its statements go by primary keys.

```
Nested Loop  (actual time=0.029..0.040 rows=3.00 loops=1)
  ->  Seq Scan on telegram_inbox_groups inbox_group  (actual time=0.007..0.008 rows=3.00 loops=1)
  ->  Subquery Scan on head  (actual time=0.009..0.010 rows=1.00 loops=3)
        ->  Limit  (actual time=0.009..0.009 rows=1.00 loops=3)
              ->  Index Only Scan using telegram_inbox_active_group_idx on telegram_inbox
                    (actual time=0.008..0.008 rows=1.00 loops=3)
                    Index Cond: ((user_id = inbox_group.user_id) AND (chat_id = inbox_group.chat_id))
                    Buffers: shared hit=13
...
Limit  (actual time=0.043..0.043 rows=1.00 loops=1)                -- releaseGroup()
  Buffers: shared hit=5
  ->  Index Only Scan using telegram_inbox_active_group_idx on telegram_inbox
        Index Cond: ((user_id = '2'::bigint) AND (chat_id = '2'::bigint))
```

### The claim of 100 k groups with the index

The order of the claim is that of the groups alone, `next_attempt_at` and the key, but the head is
an inner join: a ready group without an active update would drop out. So the plan looks up the head
of every ready group before it sorts them and takes the first, as the pull of the outbox does
([`outbox-load-test.md`](./outbox-load-test.md), "The pull of 100 k chats with the index"): 100 000
lookups, 300 000 buffers, and a sort that spills past `work_mem`, for one update or for 30.

```
Limit  (actual time=128.222..128.223 rows=1.00 loops=1)
  Buffers: shared hit=301891, temp read=495 written=945
  ->  LockRows  (actual time=122.817..122.818 rows=1.00 loops=1)
        ->  Sort  (actual time=122.806..122.807 rows=1.00 loops=1)
              Sort Method: external merge  Disk: 7544kB
              ->  Nested Loop  (actual time=0.032..105.651 rows=100000.00 loops=1)
                    ->  Seq Scan on telegram_inbox_groups inbox_group  (actual time=0.012..9.328 rows=100000.00 loops=1)
                          Filter: ((state = 'ready'::text) AND (next_attempt_at <= now()))
                    ->  Subquery Scan on head  (actual time=0.001..0.001 rows=1.00 loops=100000)
                          ->  Limit  (actual time=0.001..0.001 rows=1.00 loops=100000)
                                ->  Index Only Scan using telegram_inbox_active_group_idx on telegram_inbox
                                      (actual time=0.001..0.001 rows=1.00 loops=100000)
                                      Buffers: shared hit=300017
```

### The lease recovery with the index

`findExpiredLeases()` finds the `processing` update of each expired group among all the active
updates of the group: the index gives them by group, and the status is a filter over every one of
them, as in the lease recovery of the outbox ([`outbox-load-test.md`](./outbox-load-test.md), "The
lease recovery with the index"). So it costs as many rows as the groups it recovers have active
updates: 300 000 a group in the 3 groups layout, 1.3 s with the plans on. With no lease expired it
reads the groups alone.

```
Nested Loop  (actual time=0.145..1314.966 rows=3.00 loops=1)
  ->  Seq Scan on telegram_inbox_groups inbox_group  (actual time=0.034..0.047 rows=3.00 loops=1)
        Filter: (locked_until <= now())
  ->  Index Scan using telegram_inbox_active_group_idx on telegram_inbox inbox_update
        (actual time=0.054..438.282 rows=1.00 loops=3)
        Index Cond: ((user_id = inbox_group.user_id) AND (chat_id = inbox_group.chat_id))
        Filter: (status = 'processing'::text)
        Rows Removed by Filter: 299979
        Buffers: shared hit=9 read=220941 dirtied=4 written=5586
```

### The cleanup

`deleteFinishedUpdates()` filters on `finished_at` plus the retention, which no index serves, so
the call that finds nothing reads the whole table, 84 s in both layouts, as the cleanup of the
outbox did before its index ([`outbox-load-test.md`](./outbox-load-test.md), "The cleanup"). The
full batches are of the 3 groups run, the only one with updates past the retention, which lie at
the start of the table: four took 4.9 – 280 ms, and one 83 s, its scan started elsewhere in the
table (`synchronize_seqscans`).

```
Limit  (actual time=84580.333..84580.333 rows=0.00 loops=1)
  ->  LockRows  (actual time=84580.328..84580.328 rows=0.00 loops=1)
        ->  Seq Scan on telegram_inbox telegram_inbox_1  (actual time=84580.320..84580.320 rows=0.00 loops=1)
              Filter: (((status = 'done'::text) AND ((finished_at + '168:00:00'::interval) < now())) OR ((status = 'skipped'::text) AND ((finished_at + '720:00:00'::interval) < now())))
              Rows Removed by Filter: 100895065
              Buffers: shared hit=15088 read=10123344 dirtied=3 written=3
```

## Verdict

Without an index nothing is within the threshold: a claim takes 5 minutes and a completion up to
74 s. With the candidate index the completion is within it in both layouts, median 0.6 – 0.7 ms
and 8 ms at most, and so is the claim of a few groups, 0.4 – 1.8 ms after the first, cold one of
29 ms. The claim of 100 k ready groups is not: 101 ms for one update or for 30, ten times over,
since it looks up the head of every ready group. The threshold is not set for the lease recovery
and the cleanup, which run on timers with no caller waiting: the recovery takes 0.5 – 3 ms while no
lease has expired and 1.5 s for 3 groups of 300 000 updates whose leases have, and the cleanup that
finds nothing reads the whole table for 84 s. The proposal is in four issues:

- the head index with the vacuum of `telegram_inbox`,
  [#844](https://github.com/yuldashevsardor/telegram-bot/issues/844);
- the claim of many ready groups,
  [#845](https://github.com/yuldashevsardor/telegram-bot/issues/845);
- the lease recovery, [#846](https://github.com/yuldashevsardor/telegram-bot/issues/846);
- the cleanup, [#847](https://github.com/yuldashevsardor/telegram-bot/issues/847).
