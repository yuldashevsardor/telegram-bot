# Inbox load test

The inbox store ([`inbox.md`](./inbox.md)) measured on a large table, as the outbox store was
([`outbox-load-test.md`](./outbox-load-test.md)), twice: the claim, the completion, the lease
recovery and the cleanup on 100 M updates of groups of equal size
([#824](https://github.com/yuldashevsardor/telegram-bot/issues/824), "Data" to "Verdict"), and
every query of the store on 250 M updates skewed as production traffic is
([#871](https://github.com/yuldashevsardor/telegram-bot/issues/871), "The skewed run"). The
unblocking of a group was measured once more on the fill of #871, with the index of the failed
updates ([#892](https://github.com/yuldashevsardor/telegram-bot/issues/892), "The unblocking").

## How to run it

The test shares the database, `load-up`, `load-psql` and `load-down` with the outbox load test, and
the way the times and the plans are taken: see "How to run it" there. Its own targets, in this
order: `load-inbox-fill-done [rows=250000000] [groups=1000000]` once, then per layout
`load-inbox-fill-pending updates=<n> [hot_updates=<n>]` and `load-inbox-measure [plans=off]`. The
files they run are in `test/load/`, and what they make is in "The skewed run". The run of #824 had
fills of another form, groups of equal size and layouts of `groups` × `per_group`: they are the
files of `test/load/` at
[`8f3879f1`](https://github.com/yuldashevsardor/telegram-bot/tree/8f3879f1/test/load).

The fill of 250 M updates takes 1 hour 26 minutes and 203 GB of the disk, the layouts up to 28
minutes each (see "The skewed run"). No load target keeps the Mac awake, and an idle one falls
asleep in the middle: the runs of #871 went under `caffeinate -i` started by hand. `load-down`
gives the disk back to the host within minutes.

A layout deletes every update from the `update_id` of the layouts on, so it replaces what the
previous layout and its measurement left, and every group. It does not put back the history the
cleanup deleted: the cleanup of a measurement deletes the updates past their retention, so a later
run on the same fill finds only the call that deletes nothing. The runs of "The cleanup" (#824) put
them back before each run with the `INSERT` of the fill of the time over `n` from 1 to 5 000.
The layouts are of the fill of #871: one over a volume of the fill of #824 leaves the pending
updates of the old layout below the `update_id` of the layouts, so `load-down`, `load-up` and a new
fill come first. The 1 000 blocked groups of a layout and the groups of the pushes are among the
1 M of the default fill: a fill of fewer `groups` leaves most of them without history.

The head index (see "Results") is a migration, so `load-up` makes it and the fills insert under
it: the history is not in the partial index, so the fill does not pay the 1 minute 39 seconds its
build over the filled table of #824 took. Without the index a claim takes some 5 minutes, so a
measurement without it is to be cut short after a call or two, as the one in "Results" was: stop
`make` and the application container of the run, which `docker ps` names after the worktree. The
statement it left runs on in the database until it ends or reaches the statement timeout, holding
the group rows it locked, so the next fill waits for it, and `make` prints no plans: they are in
`docker compose -f docker-compose.load.yml logs pgsql-load`. A fill stays valid for 6 days, as the
outbox one does. The index of the cleanup (see "The cleanup") is a migration too, and unlike the
head index it holds every done and skipped update: the fill of #871 filled it as well. The index of
the failed updates (see "The unblocking") is a migration too, and the fill puts its failed updates,
one in 200, into it.

The measurement calls the real `InboxStore` with the settings of `.env`. The calls, how many of each
and in what order are in `InboxLoadTest.run()` of `test/load/inbox-load-test.ts`, each with its
reason in a comment. The run of #824 called the claims, the lease recovery and the cleanup of it,
without `countBlockedGroups()`.

## Data

The run of #824.

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
skip the groups others hold), but `InboxUpdateSource` claims one update per call, one call after
another, so the time of a claim bounds how many updates one worker loop can start a second:
100 at 10 ms.

## Results

The run of #824. The times are those of the client, in ms, from runs with `plans=off`, except the
column without an index; "first" is the first call of the run, the cold cache. The last column is
the claim that limits the groups before it looks up their heads (see "The claim of 100 k groups");
the calls it did not change were not measured again. The lease recovery of an expired batch has two
rows: the lookup that read every active update of a group, and the one that stops at the
`processing` update (see "The lease recovery").

| call | no index, 3 groups | head index, 3 groups | head index, 100 k groups | head and ready-groups index, 100 k groups |
|---|---|---|---|---|
| `claim(1)` | 276 136, 301 307 | first 29, then 0.4 – 1.6, median 0.6 | first 397, then 98 – 115, median 101 | first 32, then 0.6 – 4.2, median 1.8 |
| `claim(30)` | — | 0.5 – 1.8, median 0.6, for 3 updates | 97 – 110, median 102, for 30 updates | 1.1 – 2.4, median 1.4, for 30 updates |
| `markAsDone()` | 73 556, 292 | median 0.7, p95 1.5, max 3.7 | median 0.6, p95 1.2, max 8.1 | — |
| `findExpiredLeases()`, no lease expired | — | 0.5 | 3.1 | — |
| `findExpiredLeases()`, a batch expired, every active update read | — | 1 458, 3 leases | 13, 30 leases | — |
| `findExpiredLeases()`, a batch expired, up to the `processing` one | — | 2.3, 3 leases | — | 5.4, 30 leases |
| `deleteFinishedUpdates()`, a full batch | — | 4.9 – 280, one of 82 549 | — | — |
| `deleteFinishedUpdates()`, nothing to delete | — | 84 156 | 84 219 | — |
| `deleteIdleGroups()`, nothing to delete | — | 18 | 35 | — |

Without an index only two claims and their completions were measured, with the plans on: each claim
took minutes, and the rest of the run would have taken hours. The index is
`telegram_inbox (user_id, chat_id, update_id) WHERE status IN ('pending', 'processing')`, the
counterpart of the head index of the outbox ([`outbox-load-test.md`](./outbox-load-test.md), "Why
the index is partial"); made then by hand over the filled table, where it took 1 minute 39 seconds,
it is now the migration `1791417600000_telegram-inbox-head-index.ts`, named
`telegram_inbox_active_group_idx`. A volume of the load test made before the migration keeps the
hand-made index under that name, so the migration fails on its `load-up`: `DROP INDEX
telegram_inbox_active_group_idx` in `make load-psql` comes first, or `make load-down` and a new
fill. The plans add to the time: `claim(1)` of 100 k groups took a median of 131 ms with them and
101 ms without. The first run with the plans of the 100 k groups layout had its call of
`deleteFinishedUpdates()` that finds nothing cancelled by the statement timeout of 10 minutes; its
rerun took 83 s, as the run without the plans did, and the cause was not found.

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

The first form of the claim joined each ready group to its head and ordered the result by the
columns of the group. The head was an inner join, so a ready group without an active update would
have dropped out, and the plan looked up the head of every ready group before it sorted them and
took the first, as the pull of the outbox does
([`outbox-load-test.md`](./outbox-load-test.md), "The pull of 100 k chats with the index"): 100 000
lookups, 300 000 buffers, and a sort that spills past `work_mem`, for one update or for 30. It took
a median of 101 ms.

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

### The claim of 100 k groups

The order needs nothing from the head, so the claim takes the groups first, `ORDER BY
next_attempt_at, user_id, chat_id LIMIT … FOR UPDATE SKIP LOCKED`, and looks up the heads of those
alone. With the heads rewritten and no index on the groups the plan still read all 100 000 of them
and sorted the ready ones: 20 – 28 ms a claim, whatever the limit. The index
`telegram_inbox_groups (next_attempt_at, user_id, chat_id) WHERE state = 'ready'`
(`1791504000000_telegram-inbox-ready-groups-index.ts`) gives the groups already in the order, so the
plan reads as many of them as the claim takes. The plan of `claim(30)`, the head lookups of which
are 30, as many as the groups taken:

```
Sort  (actual time=1.276..1.279 rows=30.00 loops=1)
  CTE ready_groups
    ->  Limit  (actual time=0.016..0.052 rows=30.00 loops=1)
          ->  LockRows  (actual time=0.016..0.049 rows=30.00 loops=1)
                ->  Index Scan using telegram_inbox_ready_groups_idx on telegram_inbox_groups
                      (actual time=0.012..0.026 rows=30.00 loops=1)
                      Index Cond: (next_attempt_at <= now())
                      Filter: (state = 'ready'::text)
  CTE claimed
    ->  Update on telegram_inbox  (actual time=0.103..1.215 rows=30.00 loops=1)
          ->  Nested Loop  (actual time=0.083..0.719 rows=30.00 loops=1)
                ->  Nested Loop  (actual time=0.044..0.510 rows=30.00 loops=1)
                      ->  CTE Scan on ready_groups  (actual time=0.018..0.066 rows=30.00 loops=1)
                      ->  Subquery Scan on head  (actual time=0.014..0.014 rows=1.00 loops=30)
                            ->  Index Only Scan using telegram_inbox_active_group_idx on telegram_inbox
                                  (actual time=0.014..0.014 rows=1.00 loops=30)
```

A `ready` group without an active update would take a place among the `limit` groups and claim
nothing, where the inner join dropped it and went on to the next group. No writer makes one
(`inbox.md`, "Group states"), and the claim does not guard against it.

### The lease recovery

`findExpiredLeases()` stops at the first `processing` entry of each expired group in the head
index, as a rule its first entry ([`inbox.md`](./inbox.md), "Lease recovery"), so it reads one live
entry a group, however many active updates the group holds:

```
Nested Loop  (actual time=2.107..2.155 rows=3.00 loops=1)
  Buffers: shared hit=971
  ->  Seq Scan on telegram_inbox_groups inbox_group  (actual time=1.941..1.943 rows=3.00 loops=1)
        Filter: (locked_until <= now())
        Buffers: shared hit=958
  ->  Limit  (actual time=0.047..0.047 rows=1.00 loops=3)
        ->  Index Scan using telegram_inbox_active_group_idx on telegram_inbox
              (actual time=0.045..0.045 rows=1.00 loops=3)
              Index Cond: ((user_id = inbox_group.user_id) AND (chat_id = inbox_group.chat_id))
              Filter: (status = 'processing'::text)
              Buffers: shared hit=12
```

The statement took 2.2 ms in the database for the 3 groups and 6 ms for the 30 groups of 100 k, the
30 lookups reading 146 buffers. Nearly all of either is the seq scan of `telegram_inbox_groups` for
`locked_until`: 958 pages for the 3 groups, 1 874 for the 100 000.

Before ([#846](https://github.com/yuldashevsardor/telegram-bot/issues/846)) the lookup joined the
group to its updates with the status `processing`: the index gave every active update of the group,
the status was a filter over each, and with no `LIMIT` to stop at the first match it read them all,
300 000 a group in the 3 groups layout, 1.5 s on the client and 1.3 s with the plans on:

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

Without an index on `finished_at` the cleanup filtered on `finished_at` plus the retention, so the
call that finds nothing read the whole table, 84 s in both layouts, as the cleanup of the outbox
did before its index ([`outbox-load-test.md`](./outbox-load-test.md), "The cleanup"). The full
batches were of the 3 groups run, the only one with updates past the retention, which lie at the
start of the table: four took 4.9 – 280 ms, and one 83 s, its scan started elsewhere in the table
(`synchronize_seqscans`).

```
Limit  (actual time=84580.333..84580.333 rows=0.00 loops=1)
  ->  LockRows  (actual time=84580.328..84580.328 rows=0.00 loops=1)
        ->  Seq Scan on telegram_inbox telegram_inbox_1  (actual time=84580.320..84580.320 rows=0.00 loops=1)
              Filter: (((status = 'done'::text) AND ((finished_at + '168:00:00'::interval) < now())) OR ((status = 'skipped'::text) AND ((finished_at + '720:00:00'::interval) < now())))
              Rows Removed by Filter: 100895065
              Buffers: shared hit=15088 read=10123344 dirtied=3 written=3
```

`1791676800000_telegram-inbox-finished-index.ts` adds `telegram_inbox_finished_at_idx`,
`telegram_inbox (finished_at) WHERE status IN ('done', 'skipped')`, and the filter bounds
`finished_at` alone ([`inbox.md`](./inbox.md), "Cleanup"). Over the filled table of the 100 k
groups layout its migration took 94 s, the start of the application container included, and the
index takes 2.1 GB, as much as the primary key. Three runs over that layout, each with the 5 000
updates past the retention put back (see "How to run it"), the last one with the plans:

| call | run 1 | run 2 | run 3, plans |
|---|---|---|---|
| `deleteFinishedUpdates()`, a full batch | 3.9 – 16.4 | 6.4 – 8.9 | 4.9 – 10.5 |
| `deleteFinishedUpdates()`, nothing to delete | 1.2 | 2.0 | 1.3 |
| `markAsDone()` | — | median 1.1, p95 2.2, max 8.1 | median 0.8, p95 1.7, max 6.4 |

The completion adds an entry to the index and stays within the threshold; it took a median of
0.6 ms in the run without the index (see "Results"). The call that finds nothing reads the index,
not the table. In the run with the plans it walked 15 000 entries: the updates the three runs had
deleted, which keep their entries until a vacuum of the table, and the heap pages they point to,
1 520 buffers in 0.7 ms:

```
Bitmap Heap Scan on telegram_inbox telegram_inbox_1  (actual time=0.661..0.661 rows=0.00 loops=1)
  Filter: (((status = 'done'::text) AND (finished_at < (now() - '168:00:00'::interval))) OR ...)
  Heap Blocks: exact=1501
  Buffers: shared hit=1520
  ->  BitmapOr  (actual time=0.210..0.211 rows=0.00 loops=1)
        ->  Bitmap Index Scan on telegram_inbox_finished_at_idx  (actual time=0.208..0.208 rows=15000.00 loops=1)
              Index Cond: (finished_at < (now() - '168:00:00'::interval))
              Buffers: shared hit=15
        ->  Bitmap Index Scan on telegram_inbox_finished_at_idx  (actual time=0.002..0.002 rows=0.00 loops=1)
              Index Cond: (finished_at < (now() - '720:00:00'::interval))
              Buffers: shared hit=4
```

The plan is a custom one, with the values of the statuses: as in the outbox, a generic plan without
them could not use the partial index. What the outbox measured besides, a backlog of 1 M past the
retention and the vacuum that reads the index whole, was not measured for the inbox.

## Verdict

Of the run of #824; the skewed run has its own (see "The skewed run").

Without an index nothing is within the threshold: a claim takes 5 minutes and a completion up to
74 s. With the candidate index the completion is within it in both layouts, median 0.6 – 0.7 ms
and 8 ms at most, and so is the claim of a few groups, 0.4 – 1.8 ms after the first, cold one of
29 ms. The claim of 100 k ready groups is not: 101 ms for one update or for 30, ten times over,
since it looks up the head of every ready group. The threshold is not set for the lease recovery
and the cleanup, which run on timers with no caller waiting: the recovery takes 0.5 – 3 ms while no
lease has expired and took 1.5 s for 3 groups of 300 000 updates whose leases have, 2.3 ms since
it stops at the `processing` update (see "The lease recovery"), and the cleanup that finds nothing
read the whole table for 84 s, 1 – 2 ms with the index of
[#847](https://github.com/yuldashevsardor/telegram-bot/issues/847) (see "The cleanup"). The proposal
is in four issues:

- the head index with the vacuum of `telegram_inbox`,
  [#844](https://github.com/yuldashevsardor/telegram-bot/issues/844);
- the claim of many ready groups,
  [#845](https://github.com/yuldashevsardor/telegram-bot/issues/845);
- the lease recovery, [#846](https://github.com/yuldashevsardor/telegram-bot/issues/846);
- the cleanup, [#847](https://github.com/yuldashevsardor/telegram-bot/issues/847).

## The skewed run

Every public method of `InboxStore` that runs SQL, on a table of 203 GB laid out as production
traffic lays it out ([#871](https://github.com/yuldashevsardor/telegram-bot/issues/871)).

### Data

- The history: 249 988 314 updates over the groups 1 to 1 000 000, a private chat each, each
  update a font sent as a document, made by `inbox-fill-done.sql`. The table takes 193 GB, its
  primary key 5.2 GB and the index of the cleanup 5.2 GB, 203 GB in all, some 0.87 KB an update.
  The fill took 1 hour 26 minutes, its vacuum included.
- The updates of a group are drawn by the shape of #871, scaled by 0.924 so that they come to
  250 M:

  | share of the groups | groups | updates a group | updates | share of the updates |
  |---|---|---|---|---|
  | 60% | 599 930 | 1 – 46 | 14.1 M | 5.7% |
  | 30% | 299 967 | 47 – 462 | 76.4 M | 30.5% |
  | 9% | 90 075 | 463 – 1 848 | 104.0 M | 41.6% |
  | 1% | 10 028 | 1 849 – 9 239 | 55.5 M | 22.2% |

- The groups are interleaved: the updates of a group are spread over the whole history by
  `update_id`, and the table lies in `update_id` order, which is also that of `finished_at` but for
  the oldest 12 499, past their retention (below). How, without a sort of the 250 M rows: the
  comment of `inbox-fill-done.sql`.
- One update in 200 is `failed` and one in 200 `skipped`. The oldest 12 499 finished past their
  retention, `skipped` ones past `INBOX_SKIPPED_RETENTION`, the rest within the day before the
  fill.
- Three pending layouts of `inbox-fill-pending.sql`. A pending update goes to the group of a
  history update drawn by a hash of its number, so the heavy groups get the most and a layout
  filled again is the same. In every layout every
  thousandth group, 1 000 in all, is `blocked` by a failed update newer than its history.

  | layout | `make load-inbox-fill-pending` | pending updates | groups | fill |
  |---|---|---|---|---|
  | normal | `updates=5000` | 5 000 | 5 882 | 5 – 21 s |
  | backlog | `updates=1000000` | 1 000 000 | 330 205 | 14 – 28 min |
  | hot group | `updates=0 hot_updates=300000` | 300 000, all in group 1 | 1 001 | 6 – 15 min |

  The time of a layout is mostly the delete of the previous one and the vacuum after it.
- Each layout was filled before its run with `plans=off` and again before its run with the plans,
  so both runs saw the same layout. The full batches of the cleanup are of the first run, normal
  with `plans=off`: no later run had updates past the retention.
- The database and the machine of #824: the owner's laptop, Apple M4 Pro, the Docker Desktop VM
  of 11 CPUs and 16 GB, the defaults of `.env.dist` and of the `postgres:18-alpine` image,
  `shared_buffers` of 128 MB among them. No outbox fill beside it; the shared database of the
  worktrees ran on the same machine.

### Results

The times of the client, in ms, from the runs with `plans=off`: "first" is the first call of the
run, the cold cache, and the range and the median are of the calls after it. The times of #824 to
compare with are in "Results" and "The cleanup": the claim of 3 groups and of 100 k groups with
both indexes, the completion, the recovery and the cleanup with its index.

| call | normal | backlog | hot group |
|---|---|---|---|
| `listenReady()` | 15 | 15 | 20 |
| `claim(1)` | first 19, then 0.7 – 1.2, median 1.0 | first 28, then 0.9 – 11.5, median 1.2 | first 33, then 0.5 – 1.0, median 0.6 |
| `claim(30)` | first 21, then 2.3 – 7.3, median 2.6 | 6.8 – 11.9, median 7.3 | 0.4 – 0.9, median 0.5, for 1 update |
| `markAsDone()` | median 0.6, p95 1.4, max 6.7 | median 0.6, p95 1.0, max 3.4 | median 0.8, p95 1.1, max 3.7 |
| `findExpiredLeases()`, no lease expired | 0.8 | 9.9 | 1.1 |
| `findExpiredLeases()`, a batch expired | 2.3, 30 leases | 23, 30 leases | 4.1, 1 lease |
| `extendLease()` | median 0.2, max 0.9 | median 0.2, max 0.8 | median 0.3, max 2.5 |
| `retry()` | median 0.8, max 2.2 | median 0.7, max 1.2 | median 1.0, max 3.1 |
| `markAsFailed()` | median 0.8, max 1.5 | median 0.5, max 0.7 | median 0.7, max 1.0 |
| `markAsFailedAndBlockGroup()` | 2.0 – 2.6 | 1.9 – 4.3 | 1.8 – 2.2 |
| `push()` | median 1.2, max 3.9 | median 0.7, max 2.6 | median 0.7, max 2.9 |
| `pushBatch()` of 100 | median 7.8, max 15.7 | median 6.4, max 10.9 | median 3.6, max 4.9 |
| `deleteFinishedUpdates()`, a full batch | 3.2 – 8.4, median 4.8, 12 437 updates | — | — |
| `deleteFinishedUpdates()`, nothing to delete | 0.9 | 0.6 | 0.7 |
| `deleteIdleGroups()` | 1.6, 495 groups | 9.5, 234 groups | 0.4, none |
| `countBlockedGroups()` | median 0.3, max 0.6 | median 6.6, max 8.3 | median 0.2, max 0.6 |
| `retryBlockedGroup()`, no index of the failed updates | 160 460, 170 355 | 135 996, 134 747 | 148 077, 147 590 |
| `skipBlockedGroup()`, no index of the failed updates | 171 775, 175 240 | 148 086, 139 848 | 164 447, 147 948 |

The plans add to the time, as in #824: the unblocking took 151 – 281 s with them, the slowest in the
hot group layout, and `pushBatch()` in the backlog a median of 18 ms.

### The plans

What each call runs, from the runs with the plans, and which of its statements read a whole table
instead of an index:

| call | its statements | what they read |
|---|---|---|
| `claim()` | one | `telegram_inbox_ready_groups_idx` for the groups, `telegram_inbox_active_group_idx` for their heads, the primary keys for the writes |
| `markAsDone()`, `markAsFailed()` | the lock of the group, the write of the update, the lookup of an active update left, the state of the group | the primary keys; the head index for the update left |
| `extendLease()` | one | the primary keys |
| `retry()` | the lock, the update, the state and the delay of the group, `pg_notify` | the primary keys |
| `markAsFailedAndBlockGroup()` | the lock, the update, the state | the primary keys |
| `findExpiredLeases()` | one | a seq scan of `telegram_inbox_groups`, then the head index per expired group |
| `push()`, `pushBatch()` | the upsert of the groups, the insert of the updates with the state of their groups | the primary keys as arbiters; the state of the groups by the primary key, or a seq scan of the groups table in the layouts with few groups |
| `deleteFinishedUpdates()` | one | `telegram_inbox_finished_at_idx`, as in #824 |
| `deleteIdleGroups()`, `countBlockedGroups()` | one | a seq scan of `telegram_inbox_groups` |
| `retryBlockedGroup()`, `skipBlockedGroup()` | the lock of the group, the lookup of its failed update, the write of the update, the state | the primary keys; `telegram_inbox_failed_group_idx` for the failed update, a parallel seq scan of `telegram_inbox` before it (see "The unblocking") |

`listenReady()` runs `LISTEN`, which `auto_explain` does not log.

#### The claim in the backlog

The groups and the heads come from the indexes in a few buffers, as in #824. The time of a
`claim(30)` goes on the head rows it updates: the primary key finds each in about 5 buffers, and
some 64 of the 150 come from outside shared buffers, 0.27 ms a row (under `Memoize`, which finds
nothing to reuse: each head is another row). The 1 M pending rows take some 0.8 GB against the
128 MB of shared buffers. A `claim(30)`:

```
Sort  (actual time=9.542..9.546 rows=30.00 loops=1)
  Buffers: shared hit=628 read=68 dirtied=90
  CTE ready_groups
    ->  Limit  (actual time=0.009..0.131 rows=30.00 loops=1)
          ->  LockRows  (actual time=0.009..0.128 rows=30.00 loops=1)
                ->  Index Scan using telegram_inbox_ready_groups_idx on telegram_inbox_groups
                      (actual time=0.007..0.075 rows=30.00 loops=1)
                      Buffers: shared hit=4 read=1
  CTE claimed
    ->  Update on telegram_inbox  (actual time=0.862..9.489 rows=30.00 loops=1)
          ->  Nested Loop  (actual time=0.814..8.249 rows=30.00 loops=1)
                ->  Nested Loop  (actual time=0.025..0.269 rows=30.00 loops=1)
                      ->  Subquery Scan on head  (actual time=0.004..0.004 rows=1.00 loops=30)
                            ->  Limit  (actual time=0.003..0.003 rows=1.00 loops=30)
                                  ->  Index Only Scan using telegram_inbox_active_group_idx on telegram_inbox telegram_inbox_1
                                        (actual time=0.003..0.003 rows=1.00 loops=30)
                                        Buffers: shared hit=120
                ->  Memoize  (actual time=0.266..0.266 rows=1.00 loops=30)
                      Buffers: shared hit=86 read=64
```

#### The groups table

`findExpiredLeases()`, `deleteIdleGroups()` and `countBlockedGroups()` filter on columns no index
of `telegram_inbox_groups` has, so they read the table whole, and their time follows its size: 120
pages for the 5 882 groups of the normal layout, about 6 200 pages for the 330 205 of the backlog,
6 – 23 ms there. `countBlockedGroups()` there:

```
Finalize Aggregate  (actual time=5.721..6.899 rows=1.00 loops=1)
  Buffers: shared hit=5482 read=713
  ->  Gather  (actual time=5.672..6.896 rows=3.00 loops=1)
        Workers Launched: 2
        ->  Partial Aggregate  (actual time=4.167..4.168 rows=1.00 loops=3)
              ->  Parallel Seq Scan on telegram_inbox_groups  (actual time=0.391..4.152 rows=333.33 loops=3)
                    Filter: (state = 'blocked'::text)
                    Rows Removed by Filter: 109999
```

#### The unblocking

`InboxStore.lockBlockedGroup()` looks up the failed update of the group by `user_id`, `chat_id`
and `status = 'failed'`. In the runs of #871 no index held it: the head index has the active
statuses alone, the index of the cleanup `done` and `skipped`. So it read the whole table, 25 M
pages, in every layout:

```
Limit  (actual time=169744.144..169769.340 rows=1.00 loops=1)
  Buffers: shared hit=8890 read=25229882
  ->  Sort  (actual time=169679.106..169704.301 rows=1.00 loops=1)
        Sort Key: finished_at DESC, update_id DESC
        ->  Gather  (actual time=169678.386..169704.231 rows=2.00 loops=1)
              Workers Launched: 2
              ->  Parallel Seq Scan on telegram_inbox  (actual time=154759.534..169669.145 rows=0.67 loops=3)
                    Filter: ((user_id = '101611'::bigint) AND (chat_id = '101611'::bigint) AND (status = 'failed'::text))
                    Rows Removed by Filter: 83327797
```

The scan ran in the transaction that holds the row of the group `FOR UPDATE`. By the code, not
measured: `pushBatch()` locks the group rows of its batch, so a push with an update of that group
waits until the unblock ends, and the polling source takes no updates in while its push waits.

`1791849600000_telegram-inbox-failed-group-index.ts` adds `telegram_inbox_failed_group_idx`,
`telegram_inbox (user_id, chat_id, finished_at DESC, update_id DESC) WHERE status = 'failed'`
([#892](https://github.com/yuldashevsardor/telegram-bot/issues/892)). Its migration over the
filled table took 32 minutes, the start of the application container included, and the index
holds the 1 252 425 failed updates of the fill in 59 MB. The run of #892 was the normal layout,
filled again before each of its two runs, with 15 calls of each unblock; the database had
`shared_buffers` of 1 GB, set for
[#893](https://github.com/yuldashevsardor/telegram-bot/issues/893), where the runs of #871 had
128 MB. The times of the client, in ms:

| call | `plans=off` | with the plans |
|---|---|---|
| `retryBlockedGroup()` | 0.6 – 1.5, median 0.8 | 0.7 – 1.2, median 0.7 |
| `skipBlockedGroup()` | 0.7 – 1.9, median 0.8 | 0.7 – 0.9, median 0.8 |

The lookup is the first entry of the group in the index, in the order the statement asks for, so
no sort is left; each of the 30 lookups read 5 buffers in 0.005 – 0.009 ms:

```
Limit  (actual time=0.005..0.005 rows=1.00 loops=1)
  Buffers: shared hit=5
  ->  Index Only Scan using telegram_inbox_failed_group_idx on telegram_inbox
        (actual time=0.005..0.005 rows=1.00 loops=1)
        Index Cond: ((user_id = '102003'::bigint) AND (chat_id = '102003'::bigint))
        Heap Fetches: 1
```

The plan is a custom one, with `failed` as the value of the status, as the plan of the cleanup is
(see "The cleanup"): a generic plan without it could not use the partial index.

### Verdict of the skewed run

The claim of the worker and every completion stay within the threshold in every layout: `claim(1)`
a median of 0.6 – 1.2 ms after the first, cold call of 19 – 33 ms, as in #824, and the completions
a median of 0.2 – 2.2 ms and 7 ms at most. The skew and the size changed nothing in how they read:
by the indexes, as on 100 M updates. Two calls are past what #871 set:

- The claim in the backlog is at the threshold: `claim(30)` 6.8 – 11.9 ms, two of 15 calls over
  10 ms, and one warm `claim(1)` of 14 at 11.5 ms, from the head rows read past the 128 MB of shared
  buffers (see "The claim in the backlog"). Measuring it again with shared buffers that hold the
  active rows is [#893](https://github.com/yuldashevsardor/telegram-bot/issues/893).
- The unblocking took 2 – 3 minutes a call, a scan of the whole table under the lock of the
  group. The index of the failed updates by group of
  [#892](https://github.com/yuldashevsardor/telegram-bot/issues/892) brought it to a median of
  0.8 ms (see "The unblocking").

The calls on timers have no threshold. The cleanup of the updates is no slower than in #824: a
full batch 3.2 – 8.4 ms, the call that finds nothing 0.6 – 0.9 ms. The calls that read the groups
table grow with it, 6 – 23 ms for 330 205 groups. The push, which the polling source waits for,
took a median of 3.6 – 7.8 ms for a batch of 100 and 16 ms at most.
