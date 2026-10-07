# Inbox load test

The claim, the completion, the lease recovery and the cleanup of the inbox store
([`inbox.md`](./inbox.md)) measured on a large table
([#824](https://github.com/yuldashevsardor/telegram-bot/issues/824)), as the outbox store was
([`outbox-load-test.md`](./outbox-load-test.md)).

## How to run it

The test shares the database, `load-up`, `load-psql` and `load-down` with the outbox load test, and
the way the times and the plans are taken: see "How to run it" there. Its own targets, in this
order: `load-inbox-fill-done` once, then per layout `load-inbox-fill-pending` and
`load-inbox-measure [plans=off]`. The head index (see "Results") is a migration, so `load-up` makes
it and the fills insert under it: the done updates are not in the partial index, so the fill does
not pay the 1 minute 39 seconds its build over the filled table took. Without the index a claim
takes some 5 minutes, so a measurement without it is to be cut short after a call or two, as the one
in "Results" was: stop `make` and the application container of the run, which `docker ps` names
after the worktree. The statement it left runs on in the database until it ends or reaches the
statement timeout, holding the group rows it locked, so the next fill waits for it, and `make`
prints no plans: they are in `docker compose -f docker-compose.load.yml logs pgsql-load`. The files
they run are in
`test/load/`. A fill stays valid for 6 days, as the outbox one does.

The measurement calls the real `InboxStore` with the settings of `.env`: 15 `claim(1)`, what the
worker asks for (`CLAIM_LIMIT` of `InboxUpdateSource`), and 15 `claim(30)`, a batch the size of the
largest outbox one, since nothing in the inbox claims a batch; each is followed by `markAsDone()` of
what it gave out. Then `findExpiredLeases()` twice: with no lease expired, as the call every
`INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL` finds as a rule, and with the leases of a batch claimed
and left to expire, as after a node died. That batch is claimed by a store with a lease of 1 s
rather than the 10 minutes of `INBOX_LEASE_DURATION`: the recovery reads a lease the same way
whatever its length. Last, `deleteFinishedUpdates()` down to the call that deletes nothing, and
`deleteIdleGroups()`.

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
skip the groups others hold), but `InboxUpdateSource` claims one update per call, one call after
another, so the time of a claim bounds how many updates one worker loop can start a second:
100 at 10 ms.

## Results

The times are those of the client, in ms, from runs with `plans=off`, except the column without an
index; "first" is the first call of the run, the cold cache. The last column is the claim that
limits the groups before it looks up their heads (see "The claim of 100 k groups"); the calls it
did not change were not measured again. The expired batch of `findExpiredLeases()` in the 3 groups
column and in the last one is of the lookup that stops at the `processing` update, the 13 ms of
the lookup before it (see "The lease recovery").

| call | no index, 3 groups | head index, 3 groups | head index, 100 k groups | head and ready-groups index, 100 k groups |
|---|---|---|---|---|
| `claim(1)` | 276 136, 301 307 | first 29, then 0.4 – 1.6, median 0.6 | first 397, then 98 – 115, median 101 | first 32, then 0.6 – 4.2, median 1.8 |
| `claim(30)` | — | 0.5 – 1.8, median 0.6, for 3 updates | 97 – 110, median 102, for 30 updates | 1.1 – 2.4, median 1.4, for 30 updates |
| `markAsDone()` | 73 556, 292 | median 0.7, p95 1.5, max 3.7 | median 0.6, p95 1.2, max 8.1 | — |
| `findExpiredLeases()`, no lease expired | — | 0.5 | 3.1 | — |
| `findExpiredLeases()`, a batch expired | — | 2.3, 3 leases | 13, 30 leases | 5.4, 30 leases |
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

`findExpiredLeases()` finds the `processing` update of each expired group as the first entry of the
group in the head index whose status is `processing`, `ORDER BY update_id LIMIT 1`. The claim makes
the head `processing`, so as a rule that is the first entry, and the lookup reads one live entry a
group, however many active updates the group holds (`inbox.md`, "Lease recovery", has why it is not
the head alone, as in the outbox):

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
lease has expired and took 1.5 s for 3 groups of 300 000 updates whose leases have, 2.3 ms since
it stops at the `processing` update (see "The lease recovery"), and the cleanup that
finds nothing reads the whole table for 84 s. The proposal is in four issues:

- the head index with the vacuum of `telegram_inbox`,
  [#844](https://github.com/yuldashevsardor/telegram-bot/issues/844);
- the claim of many ready groups,
  [#845](https://github.com/yuldashevsardor/telegram-bot/issues/845);
- the lease recovery, [#846](https://github.com/yuldashevsardor/telegram-bot/issues/846);
- the cleanup, [#847](https://github.com/yuldashevsardor/telegram-bot/issues/847).
