# Outbox load test

The outbox store ([`outbox.md`](./outbox.md)) measured on a large table twice: the pull, the
completion, the lease recovery and the cleanup on 100 M done messages of chats of equal size
([#632](https://github.com/yuldashevsardor/telegram-bot/issues/632), "Data" to "Verdict"), the input
of the indexes of [#643](https://github.com/yuldashevsardor/telegram-bot/issues/643),
[#837](https://github.com/yuldashevsardor/telegram-bot/issues/837) and
[#838](https://github.com/yuldashevsardor/telegram-bot/issues/838), and every query of the store on
280 M messages skewed as production traffic is
([#872](https://github.com/yuldashevsardor/telegram-bot/issues/872), "The skewed run").

## How to run it

The test runs against a Postgres of its own, `docker-compose.load.yml`, so that the fill does not
slow down the shared database of every worktree. The targets are `load-*` of the `Makefile`, in this
order, with the shared database up (`make db-up`), whose network the application containers and the
load-test database join: `load-up`, `load-fill-done [rows=280000000] [chats=1000000]` once, then
per layout `load-fill-pending messages=<n> [hot_messages=<n>]` and `load-measure [plans=off]`;
`load-churn` sends the messages of one chat (see "Vacuum of the head index"), `load-down` removes
the database with its data. `load-up` applies the migrations, the indexes and
the vacuum settings of the outbox among them; on a volume of the earlier runs, where the index was
made by hand under the same name, the migration fails, and `load-down` gives a fresh one, without
the fill of the inbox load test either ([`inbox-load-test.md`](./inbox-load-test.md)). The files
they run are in `test/load/`, and what they make is in "The skewed run". The run of #632 had fills
of another form, 100 000 chats of equal size and layouts of `chats` × `per_chat`: they are the files
of `test/load/` at
[`8bd64949`](https://github.com/yuldashevsardor/telegram-bot/tree/8bd64949/test/load). A layout over
a volume of that fill leaves the pending messages of the old layout below the ids of the layouts, so
`load-down`, `load-up` and a new fill come first. A fill stays valid for 6 days: then its done
messages pass the retention, and the cleanup of a measurement deletes them by the thousand.

The measurement calls the real `OutboxStore` with the settings of `.env` and prints how long each
call took on the client. The plans are those of the store's own statements: `auto_explain` logs them
with `ANALYZE` and `BUFFERS` for the user of `.env`, and `load-measure` prints the log of the
database after the times. `EXPLAIN ANALYZE` adds to the time of every statement it runs, so the
times below come from a run with `plans=off`, and the plans from a run with them.

The calls, how many of each and in what order are in `OutboxLoadTest.run()` of
`test/load/outbox-load-test.ts`, each with its reason in a comment. The run of #632 called 15
`pull(1)`, what the runner asks for, and 15 `pull(30)`, the largest batch the common limit gives,
each followed by `markAsDone()` of what it gave out, then the lease recovery and the cleanup of
it. A pull the limits hold back answers nothing; it is printed with its 0 messages, left out of the
results and repeated once they let it through.

## Data

- 100 M `done` messages, 71 GB with the primary key, over the chats 1 to 100 000, finished within
  the day before the fill, inside `OUTBOX_DONE_RETENTION`; the oldest 5 000 finished 8 days before
  it, past it. The fill takes 21 minutes.
- About 1 M `pending` messages in two layouts, all of priority 0, every chat `ready`: 3 chats ×
  300 000 ("3 chats") and 100 000 chats × 10 ("100 k chats"). Their ids follow the done ones.
- The defaults of `.env.dist` and of the `postgres:18-alpine` image (`shared_buffers` of 128 MB,
  `work_mem` of 4 MB), on a laptop: Docker Desktop with 11 CPUs and 16 GB of memory.
- One process calls the store, with nothing else on the database: how the pulls of several nodes
  wait for each other on the bot row is not measured.

## Threshold

A pull of a batch is to take at most **10 ms**, and so is a completion. The pulls of all the nodes
take turns on the bot row ([`outbox.md`](./outbox.md), "Pull"), and at the default common limit of
30 messages a second a slot comes due every 33 ms: a pull that holds the row longer than that leaves
the limit unspent, however many nodes there are. 10 ms leaves the turns of several nodes room within
one slot.

## Results

The times are those of the client, in ms, from runs with `plans=off`, except the column without an
index; "first" is the first call of the run, the cold cache. The ranges leave out the pulls the
limits held back (see "How to run it").

| call | no index, 3 chats | index, 3 chats | index, 100 k chats | pull indexes, 100 k chats |
|---|---|---|---|---|
| `pull(1)` | 405 878 – 511 630 | first 140, then 1.5 – 7.4, median 2.1 | first 398, then 124 – 190, median 144 | first 30, then 1.1 – 4.3, median 1.5 |
| `pull(30)` | — | first 5, then 3.6 – 28, median 7.0, for 3 messages | first 131, then 134 – 536, median 228, for 30 messages | first 12, then 3.5 – 36, median 10.6, for 30 messages |
| `markAsDone()` | 72 – 76 | median 2.1, p95 4.1, max 14 | median 1.2, p95 4.3, max 42 | median 1.1, p95 2.5, max 5.9 |
| `findExpiredLeases()`, no lease expired | — | 0.7 | 3.1 | 13 |
| `findExpiredLeases()`, a batch expired | — | 28, 3 leases | 33, 30 leases | 38, 30 leases |
| `deleteFinishedMessages()`, a full batch | — | 4.3 – 8.5 | — | — |
| `deleteFinishedMessages()`, nothing to delete | — | 0.8 | 1.0 | 1.3 |
| `deleteIdleChats()` | — | 32 | 60 | 3.3 |

Without an index only two pulls and their completions were measured, of an earlier fill and with the
plans on: each pull took minutes, and the rest of the run would have taken hours. The index is
`telegram_outbox (chat_id, id) WHERE status IN ('pending', 'processing')`, made then by hand over
the filled table, where it took 2 minutes to build; it is now the migration
`1791153270752_telegram-outbox-head-index.ts`. The plans add to the time: `pull(1)` of 100 k chats
took a median of 161 ms with them and 144 ms without. The cleanup rows are with the index of the
cleanup as well (see "The cleanup"), measured later, on the same fill; without it the call that
deletes nothing took 81 462 and 118 604 ms. The last column is of the head priority on the chat row
and its two indexes, `1791763200000_telegram-outbox-chat-head-priority.ts`, with every index before
it, measured later still, on the same fill (see "The pull of 100 k chats with the head priority").

### Why the index is partial

An index over every status, `telegram_outbox (chat_id, id, status)`, finds the head too: the status
in the key lets it skip the done entries without reading the rows. It was built once on the 3 chats
layout, for comparison: 3.9 GB against 96 MB of the partial one, 2 minutes 18 seconds to build. Its
head lookup reads the entries of every done message of the chat before the first active one, some
200 to a page: 11 buffers for chat 1 with its 1 064 done messages, against 5 of the partial index in
the same run, which had its dead entries cleaned (see "Dead entries of the index"; the 7 buffers
there are of another fill). So it grows with the history of the chat inside the retention: a chat
with a million done messages a week, by that count, takes some 5 000 pages a lookup, while the
partial index stays at the first entry of the chat. It also holds an entry for every done message,
which every completion writes and every vacuum after the cleanup has to clean, where the partial
index holds the active ones alone.

```
Index Only Scan using telegram_outbox_chat_id_id_status_idx on telegram_outbox
    (actual time=0.049..0.049 rows=1.00 loops=1)
  Index Cond: ((chat_id = 1) AND (status = ANY ('{pending,processing}'::text[])))
  Buffers: shared hit=11
```

### The head without an index

The head of each ready chat is found by walking the primary key in `id` order and filtering every
row, so the walk passes all the done messages before it reaches the first pending one: 170 s a chat,
28 M pages read for 3 chats.

```
Index Scan using telegram_outbox_pkey on telegram_outbox
    (actual time=170300.550..170300.550 rows=1.00 loops=3)
  Rows Removed by Filter: 100000001
  Buffers: shared hit=7 read=28092413 written=11538
```

### The completion with the index

It locks the chat through the primary key of the message and finds the active message left behind it
(`releaseChat()`) as the first entry of its chat in the index; the rest of its statements go by
primary keys.

```
LockRows  (actual time=0.058..0.059 rows=1.00 loops=1)
  InitPlan 1
    ->  Index Scan using telegram_outbox_pkey on telegram_outbox
          (actual time=0.008..0.014 rows=1.00 loops=1)
  ->  Seq Scan on telegram_outbox_chats  (actual time=0.020..0.021 rows=1.00 loops=1)
...
Limit  (actual time=0.017..0.017 rows=1.00 loops=1)                -- releaseChat()
  Buffers: shared hit=6
  ->  Index Only Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
        (actual time=0.017..0.017 rows=1.00 loops=1)
        Index Cond: (chat_id = '1'::bigint)
```

### The pull of 100 k chats with the index

The index makes each head one lookup, but the pull orders the chats by the priority of their head,
so it looks up the head of every ready chat before it takes the first, and sorts them all, on disk
past `work_mem`. A ready chat that does not get into the batch costs the pull as much as one that
does. On top, `ready` reads every chat for the next due time.

```
Sort  (actual time=145.512..145.516 rows=30.00 loops=1)
  Sort Key: head.priority, chats.next_attempt_at, chats.chat_id
  Sort Method: external merge  Disk: 7944kB
  ->  Nested Loop  (actual time=0.047..113.687 rows=100000.00 loops=1)
        ->  Seq Scan on telegram_outbox_chats chats  (actual time=0.008..9.473 rows=100000.00 loops=1)
        ->  Index Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
              (actual time=0.001..0.001 rows=1.00 loops=100000)
...
Aggregate  (actual time=13.047..13.048 rows=1.00 loops=1)          -- ready: min(next_attempt_at)
  ->  Seq Scan on telegram_outbox_chats  (actual time=1.458..9.929 rows=99970.00 loops=1)
```

### The pull of 100 k chats with the head priority

The chat row keeps the priority of its head, and the pull orders the `ready` chats by it
([`outbox.md`](./outbox.md), "Tables"), the order of `telegram_outbox_chats_ready_pull_idx`: it
reads the 30 chats of its batch from the index and looks up their 30 heads. `ready` takes the
first entry of `telegram_outbox_chats_ready_next_attempt_at_idx`. A `pull(30)`, the whole
statement 2.2 ms in the database:

```
Limit  (actual time=0.254..0.503 rows=30.00 loops=1)
  ->  LockRows  (actual time=0.226..0.470 rows=30.00 loops=1)
        ->  Nested Loop  (actual time=0.220..0.439 rows=30.00 loops=1)
              ->  Index Scan using telegram_outbox_chats_ready_pull_idx on telegram_outbox_chats chats
                    (actual time=0.071..0.121 rows=30.00 loops=1)
                    Index Cond: (next_attempt_at <= (InitPlan 4).col1)
              ->  Index Only Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
                    (actual time=0.009..0.009 rows=1.00 loops=30)
...
Limit  (actual time=0.050..0.050 rows=1.00 loops=1)                -- ready: min(next_attempt_at)
  ->  Index Scan using telegram_outbox_chats_ready_next_attempt_at_idx on telegram_outbox_chats
        (actual time=0.049..0.050 rows=1.00 loops=1)
```

On the client a batch still takes a median of 10.6 ms (see "Results"), and the 2 s the measurement
idles before each batch, to save up its budget, make most of it. A one-off script, not kept, pulled
the same `pull(30)` through the store, 16 times each way, and gave the bot row its budget by an
`UPDATE`: right after it a pull took 1.4 – 2.4 ms, after 2 s of idle 7.6 – 33 ms, a median of
10. With `log_min_duration_statement` the database logged for the pulls after the idle 1.5 –
3.8 ms to plan the statement (the `bind` of the prepared statement) and 2.0 – 2.7 ms to run it; the
rest is the wait of the client. A pull holds the bot row while its statement runs, not while it is
planned or on its way, and that hold is what the threshold is for (see "Threshold"): 2 – 3 ms. So
the pull of 100 k ready chats is taken as within the threshold. In both runs of the measurement,
with the plans and without, the 5th, the 10th and the 15th batch took 28 – 36 ms; why is not
measured.

The lease recovery that finds no lease took 13 ms against the 3.1 before: the same seq scan of the
100 000 chats, 1 873 buffers, but the pulls no longer read every chat right before it. Repeated in
`psql`, the scan took 13 – 18 ms first and 2.5 – 3.1 ms right after. `deleteIdleChats()` took
3.3 ms against the 60 before, and not by the new indexes: both are of the `ready` chats, and it
reads the `idle` ones by the same seq scan of the chats; why it took less is not measured.

### The lease recovery

`findExpiredLeases()` finds the `processing` message of each expired chat as the head of the chat,
the first entry of the chat in the head index: a chat holds one `processing` message at a time, and
it is the head ([`outbox.md`](./outbox.md), "Lease recovery"). So it reads one live entry a chat,
however many active messages the chat holds, and the dead ones before it until a vacuum cleans them
(see "Dead entries of the index"):

```
Nested Loop  (actual time=0.371..0.560 rows=3.00 loops=1)
  Buffers: shared hit=19
  ->  Seq Scan on telegram_outbox_chats chats  (actual time=0.081..0.082 rows=3.00 loops=1)
        Filter: (locked_until <= now())
  ->  Subquery Scan on head  (actual time=0.126..0.126 rows=1.00 loops=3)
        Filter: (head.status = 'processing'::text)
        ->  Limit  (actual time=0.125..0.125 rows=1.00 loops=3)
              ->  Index Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
                    (actual time=0.118..0.118 rows=1.00 loops=3)
                    Index Cond: (chat_id = chats.chat_id)
                    Buffers: shared hit=16
```

The statement took 0.66 ms in the database for the 3 chats and 22 ms for the 30 chats of 100 k,
nearly all of the latter the seq scan of the 100 000 chats for their `locked_until`; the 30 head
lookups read 147 buffers in all. The rest of the time in the table is the client's: the measurement
waits out `OUTBOX_LEASE_DURATION`, 90 s, longer than `DATABASE_CONNECTION_IDLE_TIMEOUT`, 10 s, so
the call opens a new connection, and the log shows postgres.js reading `pg_type` on it right before
the statement.

Before ([#836](https://github.com/yuldashevsardor/telegram-bot/issues/836)) the lookup joined the
chat to its messages with the status `processing`: the index gave every active message of the chat,
the status was a filter over each, and with no `LIMIT` to stop at the head it read them all, 300 000
a chat in the 3 chats layout, 706 ms on the client:

```
Nested Loop  (actual time=0.180..791.463 rows=3.00 loops=1)
  ->  Seq Scan on telegram_outbox_chats chats  (actual time=0.033..0.040 rows=3.00 loops=1)
        Filter: (locked_until <= now())
  ->  Index Scan using telegram_outbox_active_chat_id_idx on telegram_outbox message
        (actual time=0.118..263.772 rows=1.00 loops=3)
        Index Cond: (chat_id = chats.chat_id)
        Filter: (status = 'processing'::text)
        Rows Removed by Filter: 299958
        Buffers: shared hit=3929 read=67027 dirtied=1 written=387
```

### Dead entries of the index

A message leaves two dead entries in the head index: its `status` is in the index predicate, so
neither the pull nor the completion updates the row in place (no HOT update), and the version it
leaves behind keeps its entry until a vacuum cleans the index. A plain `VACUUM` does not always:
while the dead rows lie on less than 2% of the pages of the table it skips the indexes ("index scan
bypassed" in `VACUUM (VERBOSE)`), and 2% of this table is some 180 000 pages. A run of the 3 chats
layout over the 2.8 M dead entries the earlier layouts of a fill had left found each head by walking
them:

```
Index Only Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
    (actual time=9.004..9.004 rows=1.00 loops=1)
  Index Cond: (chat_id = 1)
  Buffers: shared hit=2305
```

so `pull(30)` of the 3 chats took 7 – 58 ms, median 20. After `VACUUM (INDEX_CLEANUP ON)
telegram_outbox` the same lookup read 7 buffers in 0.4 ms. The fill of a layout runs that vacuum, so
the table above is measured without them. At the common limit of 30 messages a second the outbox
leaves some 5 M such entries a day, and autovacuum at its defaults comes to a table of 100 M rows
once it has 20 M dead rows. What the migration sets against both is in the next section.

### Vacuum of the head index

The migration sets two options of `telegram_outbox`: `vacuum_index_cleanup = ON`, so a vacuum never
skips the indexes, and `autovacuum_vacuum_max_threshold = 100000`, so autovacuum comes after at most
100 000 dead rows, whatever the size of the done history; a table under half a million rows keeps
the default fifth of its rows, which comes sooner. The dead entries a head lookup walks are those of
its own chat, so the worst case is one chat that sends all of them: `make load-churn chat=1
messages=45000` over the 3 chats layout, each message pulled and completed in transactions of its
own, as the store does, leaves 90 000 dead rows, all of chat 1, just under the threshold. Its head
lookup then read 180 buffers in 0.36 ms, warm, against 11 after 1 000 messages: some 500 dead
entries a page.

6 000 more messages took the table past the threshold, and autovacuum came within 20 seconds:

```
automatic vacuum of table "docker_db.public.telegram_outbox": index scans: 1
	pages: 0 removed, 9113609 remain, 4117 scanned (0.05% of total), 0 eagerly scanned
	index scan needed: 4057 pages from table (0.04% of total) had 102000 dead item identifiers removed
	index "telegram_outbox_pkey": pages: 276655 in total, 0 newly deleted, 0 currently deleted, 0 reusable
	index "telegram_outbox_active_chat_id_idx": pages: 3473 in total, 196 newly deleted, 196 currently deleted, 0 reusable
	avg read rate: 183.073 MB/s, avg write rate: 0.004 MB/s
	buffer usage: 16948 hits, 279523 reads, 6 dirtied
	system usage: CPU: user: 1.32 s, system: 0.16 s, elapsed: 11.92 s
```

After it the head lookup read 7 buffers. The run took 12 s, nearly all of it reading the primary
key, 2.2 GB of 100 M rows: an index vacuum reads every index whole, however few dead rows it
removes. At the common limit of 30 messages a second the messages leave 60 dead rows a second, and
the cleanup, once the retention has passed, deletes 30 more, so autovacuum comes every 18 to 28
minutes, 12 s of reading each time. One chat alone, at the private limit of 3 a second, takes 4.6
hours to reach the threshold, with the 180 buffers above at the end. The run above was made with
`autovacuum_vacuum_scale_factor = 0` and `autovacuum_vacuum_threshold = 100000`, the same trigger at
this size; repeated with the option of the migration, it gave the same 180 buffers before
autovacuum, a run of 12.8 s and 7 buffers after.

The same churn with `vacuum_index_cleanup` back at its default, `auto`, shows why the option is
there: autovacuum came on the threshold as well, but skipped the indexes, and the dead entries
stayed for the next lookups to walk, 203 buffers, growing with every message after it:

```
automatic vacuum of table "docker_db.public.telegram_outbox": index scans: 0
	index scan bypassed: 4935 pages from table (0.05% of total) have 102000 dead item identifiers
	index "telegram_outbox_active_chat_id_idx": pages: 3473 in total, 0 newly deleted, 196 currently deleted, 196 reusable
	system usage: CPU: user: 0.15 s, system: 0.01 s, elapsed: 0.44 s
```

The runs are logged by `log_autovacuum_min_duration = 0` of `docker-compose.load.yml`. No target
prints them after `make load-churn`: `docker compose -f docker-compose.load.yml logs pgsql-load`
does, and `make load-measure` prints those that fall within its own run, with the plans.

### The cleanup

Without an index on `finished_at` the call that finds nothing read the whole table, every
`OUTBOX_MAINTENANCE_CLEANUP_INTERVAL` on every node. It did not hold the bot row or the chats, but
it is one statement, and for the whole of its run it held its snapshot: no vacuum removed the row
versions, and the dead entries of the head index with them, that the pulls and the completions left
meanwhile.

```
Seq Scan on telegram_outbox telegram_outbox_1  (actual time=114548.029..114548.029 rows=0.00 loops=1)
  Filter: (((status = 'done'::text) AND ((finished_at + '168:00:00'::interval) < now())) OR ...)
  Buffers: shared hit=6113 read=9132300 dirtied=6
```

`1791320758530_telegram-outbox-finished-index.ts` adds `telegram_outbox_finished_at_idx`,
`telegram_outbox (finished_at) WHERE status IN ('done', 'skipped')`, and the filter bounds
`finished_at` alone ([`outbox.md`](./outbox.md), "Cleanup"). It took 2 minutes to build on the
filled table and takes 2.1 GB, as much as the primary key: it holds every done message. The call
that finds nothing reads 8 buffers of it, 0.8 and 1.0 ms on the client:

```
Bitmap Heap Scan on telegram_outbox telegram_outbox_1  (actual time=0.050..0.051 rows=0.00 loops=1)
  Buffers: shared hit=5 read=3
  ->  BitmapOr  (actual time=0.025..0.025 rows=0.00 loops=1)
        ->  Bitmap Index Scan on telegram_outbox_finished_at_idx  (actual time=0.020..0.020 rows=0.00 loops=1)
              Index Cond: (finished_at < (now() - '168:00:00'::interval))
        ->  Bitmap Index Scan on telegram_outbox_finished_at_idx  (actual time=0.001..0.001 rows=0.00 loops=1)
              Index Cond: (finished_at < (now() - '720:00:00'::interval))
```

Every completion adds an entry to it. In the same runs the completion took a median of 2.4 ms for
3 chats and 0.7 ms for 100 k chats, 4.6 and 1.5 ms at the 95th percentile: within the spread of the
table above. The full batches, the 5 000 messages past the retention at the start of the table,
took 4.3 – 8.5 ms.

Every vacuum of the table now reads it whole as well: `vacuum_index_cleanup = ON` makes a vacuum
clean every index (see "Vacuum of the head index"). `make load-churn chat=1 messages=51000` over the
3 chats layout brought autovacuum, which removed 74 409 dead rows and read 570 536 pages, 4.4 GB,
twice the 2.2 GB of the run without the index, in 39.6 s against 12 s. A `VACUUM (ANALYZE)` of
`telegram_inbox`, run by another load test at the same time, read the same disk, so part of the
40 s is its share. At the common limit of 30 messages a second autovacuum comes every 18 to 28
minutes, so the outbox reads its indexes for some 40 s out of each such span.

A backlog takes the batch back to the seq scan. 1 M done messages were moved 8 days back with an
`UPDATE` and a `VACUUM (ANALYZE)`, so their new versions lie all over the table. The planner then
estimates 1.5 M rows past the retention and expects the seq scan to meet a batch of them soon; its
plan, with the values of the store in `psql`, read 191 pages for a batch:

```
Limit  (actual time=0.221..2.957 rows=1000.00 loops=1)
  ->  LockRows  (actual time=0.220..2.906 rows=1000.00 loops=1)
        ->  Seq Scan on telegram_outbox telegram_outbox_1  (actual time=0.187..1.776 rows=1000.00 loops=1)
              Buffers: shared read=191
```

Through the store the 1 000 batches took 30 – 403 ms, a median of 68, 69 s in all. Such a batch is
fast only while the rows past the retention are dense where the scan starts, and a seq scan of a
table this large need not start at the first page: with `synchronize_seqscans`, on by default, it
starts where the last scan of the table reported it was. Before the index, a batch of the first fill
took 86 s once, its scan passing 100.9 M rows before its own. The call that found nothing right
after the backlog took 105 ms: the deleted messages leave their dead entries at the start of the
index, and the call walks them. The deletes took the table past the threshold of autovacuum (see
"Vacuum of the head index"), and after it the same call read 8 buffers again.

The statement is prepared: postgres.js prepares every statement, and after five runs PostgreSQL may
switch one to a generic plan, built without the values. Without the values of the status no
partial index is proven to cover the filter, so the generic plan is the seq scan, which it
estimates at 13 M against the 17 k of the custom one: PostgreSQL keeps the custom plan. Seven runs
of the statement prepared in `psql` with the parameters of the store were all custom
(`pg_prepared_statements`).

## Verdict

With the head index the completion is within the threshold at its median, 1 – 2 ms, and at its
95th percentile, 4 ms, though not at its maximum, 14 and 42 ms. So is the pull of a few chats at its
median, 2 – 7 ms, while the index is kept clean of dead entries; a batch of the 3 chats took up to
28 ms once. The pull of 100 k ready chats was not while the pull read the priority from the heads:
a batch took a median of 228 ms, some 23 times over, and the pull of one message 144 ms. With the
head priority on the chat row a batch holds the bot row 2 – 3 ms, and the pull of one message takes
a median of 1.5 ms on the client (see "The pull of 100 k chats with the head priority"). The
threshold is not set for the lease recovery and the cleanup, which hold neither the bot row nor a
caller waiting: the lease recovery takes 1 – 3 ms while no lease has expired, 13 ms over 100 k
chats the pulls no longer read, and under 1 ms in the database for the 3 chats of 300 000 messages
whose leases have, 28 ms on the client with its new connection, and the cleanup that finds nothing
reads its index in 1 ms, while a backlog of 1 M takes its batches back to the seq scan, a median of
68 ms each. The proposal is a comment on #643:
https://github.com/yuldashevsardor/telegram-bot/issues/643#issuecomment-5984131010

## The skewed run

Every public method of `OutboxStore` that runs SQL, and the read of `OutboxFinishedMessageReader`
that `OutboxResultWaiter` falls back to, on a table of 206 GB laid out as production traffic lays it
out ([#872](https://github.com/yuldashevsardor/telegram-bot/issues/872)), as the inbox store was
([`inbox-load-test.md`](./inbox-load-test.md), "The skewed run").

### Data

- The history: 279 984 018 messages over the chats 1 to 1 000 000, a reply of the bot in a private
  chat each, made by `outbox-fill-done.sql`. The table takes 194 GB, its primary key 6.0 GB and the
  index of the cleanup 6.0 GB, 206 GB in all, some 0.74 KB a message. The fill took 1 hour 28
  minutes, its vacuum included, under `caffeinate -i` started by hand, as the runs of the inbox.
- The messages of a chat are drawn by the shape of #872, scaled by 1.035 so that they come to 280 M:

  | share of the chats | chats | messages a chat | messages | share of the messages |
  |---|---|---|---|---|
  | 60% | 599 930 | 1 – 52 | 15.8 M | 5.7% |
  | 30% | 299 967 | 53 – 517 | 85.5 M | 30.5% |
  | 9% | 90 075 | 518 – 2 070 | 116.5 M | 41.6% |
  | 1% | 10 028 | 2 071 – 10 348 | 62.1 M | 22.2% |

- The chats are interleaved: the messages of a chat are spread over the whole history by `id`, and
  the table lies in `id` order, which is also that of `finished_at` but for the oldest 13 999, past
  their retention (below). How, without a sort of the 280 M rows: the comment of
  `outbox-fill-done.sql`.
- One message in 200 is `failed` and one in 200 `skipped`. The oldest 13 999 finished past their
  retention, `skipped` ones past `OUTBOX_SKIPPED_RETENTION`, the rest within the day before the
  fill.
- Three pending layouts of `outbox-fill-pending.sql`, all of the priority of `OutboxPriority.Call`.
  A pending message goes to the chat of a history message drawn by a hash of its number, so the
  heavy chats get the most and a layout filled again is the same. In every layout every thousandth
  chat, 1 000 in all, is `blocked` by a failed message newer than its history.

  | layout | `make load-fill-pending` | pending messages | chats | fill |
  |---|---|---|---|---|
  | normal | `messages=5000` | 5 000 | 5 882 | 7 – 26 s |
  | backlog | `messages=1000000` | 1 000 000 | 329 968 | 4.5 – 5.3 min |
  | hot chat | `messages=0 hot_messages=300000` | 300 000, all in chat 1 | 1 001 | 29 – 41 s |

- Each layout was filled before its run with `plans=off` and again before its run with the plans, so
  both runs saw the same layout, and once more for a third run with `plans=off` and the connections
  of `.env.dist`, the times of "Results" (see "The pull").
- The database and the machine of #632: the owner's laptop, Apple M4 Pro, the Docker Desktop VM of
  11 CPUs and 16 GB, the defaults of `.env.dist` and of the `postgres:18-alpine` image,
  `shared_buffers` of 128 MB and `jit_above_cost` of 100 000 among them. No inbox fill beside it.

### Results

The times of the client, in ms, from the runs with `plans=off` and the connections of `.env.dist`
(see "The pull"): "first" is the first call of the run, the cold cache, and the range and the
median are of the calls after it; a pull the limits held back is left out (see "How to run it").
The times of #632 to compare with are in "Results" and "The cleanup".

| call | normal | backlog | hot chat |
|---|---|---|---|
| `listenReady()` | 47 | 19 | 19 |
| `pull(1)` | first 78, then 5.1 – 9.9, median 6.3 | first 83, then 21.5 – 33.4, median 26.2 | first 16, then 1.3 – 7.4, median 2.2 |
| `pull(30)` | first 14, then 5.7 – 23.7, median 8.1 | first 55, then 45.7 – 142.3, median 52.1 | first 7.4, then 2.2 – 28.7, median 3.8, for 1 message |
| `markAsDone()` | median 0.9, p95 1.9, max 7.6 | median 0.9, p95 3.5, max 10.1 | median 2.4, p95 7.4, max 8.5 |
| `retry()` | median 1.8, max 3.5 | median 5.8, max 20.6 | median 4.1, max 5.1 |
| `markAsFailed()` | median 1.9, max 3.5 | median 5.9, max 17.6 | median 4.5, max 6.3 |
| `markAsFailedAndBlockChat()` | 3.2 – 3.7 | 3.0 – 5.3 | 2.0 – 3.6 |
| `findExpiredLeases()`, no lease expired | 1.7 | 31 | 5.5 |
| `findExpiredLeases()`, a batch expired | 31, 30 leases | 63, 30 leases | 23, 1 lease |
| `find()` of the messages of a pull | median 0.4, max 1.3, 30 messages | median 2.1, max 7.3, 30 messages | median 0.4, max 1.4, 1 message |
| `push()` | median 1.0, max 5.7 | median 5.0, max 23 | median 1.0, max 7.6 |
| `pushBatch()` of 1 000 | median 19, max 40 | median 23, max 72 | median 15, max 30 |
| `pause()` | median 0.2, max 0.6 | median 0.3, max 0.5 | median 0.2, max 0.5 |
| `readBacklog()` | first 7.7, then 4.3 – 5.0, median 4.5 | first 1 985, then 1 168 – 1 357, median 1 207 | first 366, then 66 – 94, median 68 |
| `countBlockedChats()` | median 0.6, max 0.8 | median 12, max 20 | median 0.6, max 1.1 |
| `deleteFinishedMessages()`, a full batch | 4.0 – 13.7, median 4.9, 13 929 messages | — | — |
| `deleteFinishedMessages()`, nothing to delete | 1.3 | 2.1 | 1.4 |
| `deleteIdleChats()` | 2.0, 495 chats | 11, 261 chats | 0.8, none |
| `retryBlockedChat()` | 206 136, 207 283 | 209 217, 223 284 | 208 378, 188 248 |
| `skipBlockedChat()` | 226 542, 223 816 | 224 049, 223 047 | 189 341, 201 688 |

The full batches of the cleanup are of the first run of the normal layout, with the connections of
the `.env` of the owner: no later run had messages past the retention. The rest of the 13 999
messages past it are the failed ones, which the cleanup keeps. During the run of the backlog a
review session of another worktree ran its checks in the same Docker VM, the load average of the
host up to 63: the completions, `push()` and `find()` of that column took 2 to 6 times their times
in the first run of the layout, `retry()` a median of 1.0 ms there and `push()` 0.8. The pulls that
block a chat, right after an unblock, took 40 – 119 ms in the normal and the backlog layouts; each
follows a scan of the whole table (see "The unblocking"), and their plans were not looked into.

### The plans

What each call reads, from the runs with the plans:

| call | what its statements read |
|---|---|
| `pull()` | `telegram_outbox_chats_ready_pull_idx` for the chats, the head index for their heads, as in #632; in the normal layout every active message for the heads to update (see "The pull") |
| `markAsDone()`, `retry()`, `markAsFailed()`, `markAsFailedAndBlockChat()` | the primary keys; the head index for the message left and the head priority |
| `findExpiredLeases()`, `deleteIdleChats()`, `countBlockedChats()` | a seq scan of `telegram_outbox_chats`, then the head index per expired chat |
| `find()` | the primary key, some 7 buffers a message |
| `push()`, `pushBatch()` | the primary keys as arbiters, the head index for the head priority |
| `pause()` | the bot row |
| `readBacklog()` | every active message: the head index and the row of each (see "The status line") |
| `deleteFinishedMessages()` | `telegram_outbox_finished_at_idx`, as in #632 |
| `retryBlockedChat()`, `skipBlockedChat()` | a parallel seq scan of `telegram_outbox` for the failed message (see "The unblocking") |

`listenReady()` runs `LISTEN`, which `auto_explain` does not log.

#### The pull

The pull reads the chats and their heads as in #632, a few buffers a head, yet it took longer, for
a reason of its own in each layout. To tell its parts apart, the pulls alone were measured again on
the same fill, with `log_min_duration_statement = 0` for the user of `.env`, so that the database
logged the bind, the planning of the prepared statement, and the execute of each pull; and with a
setting of the planner for that user in two of the runs. The times of the database leave out the
first pull of each run; `pull(30)` includes the batch left to expire. The client times are the
medians:

| layout, setting | bind | execute of `pull(1)` | execute of `pull(30)` | held back | client, `pull(1)` and `pull(30)` |
|---|---|---|---|---|---|
| normal | 0.6 – 5.0 | 3.4 – 11.4, median 4.0 | 4.3 – 14.3, median 12.0 | 0.2 – 0.5 | 12.4, 17.6 |
| normal, `enable_hashjoin = off` | 0.4 – 2.9 | 2.7 – 5.3, median 3.6 | 10.1 – 14.9, median 13.0 | 2.3 – 4.4 | 4.9, 19.0 |
| backlog | 0.4 – 4.1 | 22.2 – 31.2, median 24.1 | 25.5 – 72.3, median 34.8 | 18.9 – 24.0 | 25.9, 42.0 |
| backlog, `jit = off` | 0.4 – 6.7 | 0.3 – 0.5, median 0.3 | 1.4 – 8.1, median 2.2 | 0.1 – 0.3 | 1.9, 7.2 |

In the backlog the pull is compiled each time. The planner does not know the budget, which is
computed in the statement, and estimates the heads of 109 608 ready chats to lock; the plan costs
107 291, past `jit_above_cost`, so PostgreSQL compiles it with JIT on every run, a pull the limits
hold back included, which took 14.1 ms in the database and read 14 buffers:

```
JIT:
  Functions: 108
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 1.670 ms (Deform 0.574 ms), Inlining 0.000 ms, Optimization 0.413 ms, Emission 13.511 ms, Total 15.594 ms
```

In the normal layout the plan costs 787 and is not compiled, but the update of the heads reads every
active message of the table through the head index with its row, where the backlog looks each head
up by the primary key. The planner expects 2 active messages: the statistics of a table of 280 M
rows hold next to none of its 5 000. With hash joins off it reads them all the same, by another
join, a pull the limits hold back included. In #632 the layouts held 1 M pending messages
of 101 M, which the statistics saw. A `pull(30)`:

```
->  Update on telegram_outbox telegram_outbox_1  (actual time=7.051..7.618 rows=30.00 loops=1)
      Buffers: shared hit=5450
      ->  Hash Join  (actual time=6.957..7.086 rows=30.00 loops=1)
            ->  CTE Scan on heads  (actual time=0.470..0.587 rows=30.00 loops=1)
            ->  Hash  (actual time=6.469..6.470 rows=4925.00 loops=1)
                  ->  Index Scan using telegram_outbox_active_chat_id_idx on telegram_outbox telegram_outbox_1
                        (cost=0.25..20.30 rows=2 width=14) (actual time=0.393..5.492 rows=4925.00 loops=1)
                        Buffers: shared hit=5032
```

The first runs of the layouts went with the connections of the `.env` of the owner,
`DATABASE_CONNECTION_MAX_LIFETIME` of 10 s, where `.env.dist` has 600: the store took a new
connection every 10 s, and on each the pull was parsed, bound and run cold again, 33 – 72 ms in the
database. The table of "Results" and the runs above are with the connections of `.env.dist`.

The proposal is [#957](https://github.com/yuldashevsardor/telegram-bot/issues/957).

#### The status line

`readBacklog()` counts the pending and the processing messages through the head index, whose entries
do not hold the status, so it reads the row of each active message. In the backlog, 1 M of them, 400
000 pages from the disk:

```
->  Aggregate  (actual time=1472.818..1472.819 rows=1.00 loops=1)
      Buffers: shared hit=623121 read=399748 dirtied=7916 written=21493
      ->  Index Scan using telegram_outbox_active_chat_id_idx on telegram_outbox
            (actual time=0.054..1416.152 rows=1014505.00 loops=1)
```

The statement took 1.6 s there and 6.5 ms for the 19 505 active messages of the normal layout. Every
node calls it every `OUTBOX_MAINTENANCE_STATUS_LOG_INTERVAL`, 10 s (`OutboxMaintenance`). The
proposal is [#954](https://github.com/yuldashevsardor/telegram-bot/issues/954).

#### The unblocking

`OutboxStore.lockBlockedChat()` looks up the failed message of the chat by `chat_id` and `status =
'failed'`, which no index holds: the head index has the active statuses alone, the index of the
cleanup `done` and `skipped`. So it reads the whole table, 25 M pages, in every layout, as the inbox
did before its index of the failed updates ([`inbox-load-test.md`](./inbox-load-test.md), "The
unblocking"):

```
Limit  (actual time=131397.259..131409.493 rows=1.00 loops=1)
  Buffers: shared hit=6150 read=25495007
  ->  Sort  (actual time=131332.100..131344.333 rows=1.00 loops=1)
        ->  Gather  (actual time=0.355..131344.233 rows=4.00 loops=1)
              Workers Launched: 2
              ->  Parallel Seq Scan on telegram_outbox  (actual time=72210.185..131321.257 rows=1.33 loops=3)
                    Filter: ((chat_id = '1464'::bigint) AND (status = 'failed'::text))
                    Rows Removed by Filter: 93662033
```

The scan runs in the transaction that holds the row of the chat `FOR UPDATE`. The proposal is
[#953](https://github.com/yuldashevsardor/telegram-bot/issues/953).

#### Autovacuum in every run

Every run had one autovacuum of `telegram_outbox`, though it found 124 to 14 981 dead rows, under
the threshold of 100 000 of "Vacuum of the head index". Each removed them and read both full
indexes, 1.55 M pages, 12 GB, in 73 – 87 s:

```
automatic vacuum of table "docker_db.public.telegram_outbox": index scans: 1
	index scan needed: 1961 pages from table (0.01% of total) had 14981 dead item identifiers removed
	index "telegram_outbox_pkey": pages: 767736 in total, 4 newly deleted, 4 currently deleted, 0 reusable
	index "telegram_outbox_finished_at_idx": pages: 763812 in total, 11 newly deleted, 11 currently deleted, 0 reusable
	buffer usage: 66386 hits, 1579641 reads, 16241 dirtied
	system usage: CPU: user: 5.17 s, system: 0.46 s, elapsed: 87.25 s
```

The inserts bring it. In PostgreSQL 18 the threshold of the inserts is
`autovacuum_vacuum_insert_threshold`, 1 000, plus `autovacuum_vacuum_insert_scale_factor`, 0.2,
times the rows times the share of the pages not frozen, and the fill was frozen: `pg_class` showed
25 458 794 of its 25 459 094 pages in `relallfrozen`. So the threshold came to some 1 700 inserted
messages, which a layout and the pushes of a run pass. The whole indexes are read for
`vacuum_index_cleanup = ON` (see "Vacuum of the head index"), which keeps a vacuum from skipping
them however few dead rows there are. The proposal is
[#958](https://github.com/yuldashevsardor/telegram-bot/issues/958).

### Verdict of the skewed run

Every completion stays within the threshold at its median in every layout, 0.9 – 5.9 ms. At its
maximum it is over it only in the run of the backlog that shared the VM with the checks of another
session, 20.6 ms at most, where the first run of the layout gave 8.6. The pull does not stay within
it:

- The pull of the backlog is over it, `pull(1)` a median of 26.2 ms and `pull(30)` 52.1, compiled
  by JIT on every run, a pull the limits hold back included. With JIT off for the role the same
  layout gave a median of 1.9 and 7.2 ms (see "The pull").
- The pull of the normal layout is within it at the median, 6.3 and 8.1 ms, but its update of the
  heads reads every active message of the table, which the statistics of the long history do not
  see, so its time grows with them (see "The pull").
- The unblocking took 2.3 – 3.8 minutes a call in all the runs, a scan of the whole table under the
  lock of the chat (see "The unblocking").

The calls on timers have no threshold. The cleanup is no slower than in #632: a full batch
4.0 – 13.7 ms, the call that finds nothing 1.3 – 2.1 ms. The lease recovery took 1.7 – 63 ms. The
status line reads every active message, 1.2 s a call in the backlog, every 10 s (see "The status
line"). The push of the transformer took a median of 1.0 – 5.0 ms, the batch of the bulk command
15 – 23 ms for 1 000 messages. Autovacuum read the whole indexes of the table in every run, brought
by some 1 700 inserts (see "Autovacuum in every run").

The proposals: the pull [#957](https://github.com/yuldashevsardor/telegram-bot/issues/957), the
unblocking [#953](https://github.com/yuldashevsardor/telegram-bot/issues/953), the status line
[#954](https://github.com/yuldashevsardor/telegram-bot/issues/954) and autovacuum
[#958](https://github.com/yuldashevsardor/telegram-bot/issues/958).
