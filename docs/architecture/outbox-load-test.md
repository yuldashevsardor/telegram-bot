# Outbox load test

The pull, the completion, the lease recovery and the cleanup of the outbox store
([`outbox.md`](./outbox.md)) measured on a large table
([#632](https://github.com/yuldashevsardor/telegram-bot/issues/632)), the input of the indexes of
[#643](https://github.com/yuldashevsardor/telegram-bot/issues/643).

## How to run it

The test runs against a Postgres of its own, `docker-compose.load.yml`, so that the fill does not
slow down the shared database of every worktree. The targets are `load-*` of the `Makefile`, in this
order, with the shared database up (`make db-up`), whose network the application containers and the
load-test database join: `load-up`, `load-fill-done` once, then per layout `load-fill-pending` and
`load-measure`; `load-churn` sends the messages of one chat (see "Vacuum of the head index"),
`load-down` removes the database with its data. `load-up` applies the migrations, the head index
and the vacuum settings of the outbox among them. The files they run are in `test/load/`. A fill
stays valid for 6 days: then its done messages pass the retention, and the cleanup of a measurement
deletes them by the thousand.

The measurement calls the real `OutboxStore` with the settings of `.env` and prints how long each
call took on the client. The plans are those of the store's own statements: `auto_explain` logs them
with `ANALYZE` and `BUFFERS` for the user of `.env`, and `load-measure` prints the log of the
database after the times. `EXPLAIN ANALYZE` adds to the time of every statement it runs, so the
times below come from a run with `plans=off`, and the plans from a run with them.

The calls are 15 `pull(1)`, what the runner asks for, and 15 `pull(30)`, the largest batch the
common limit gives, each followed by `markAsDone()` of what it gave out. A pull the limits hold back
answers nothing; it is printed with its 0 messages, left out of the results and repeated once they
let it through. Then `findExpiredLeases()` twice: with no lease expired, as the call every
`OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL` finds as a rule, and with the leases of a batch pulled
and left until `OUTBOX_LEASE_DURATION` passed, as after a node died. Last,
`deleteFinishedMessages()` down to the call that deletes nothing, and `deleteIdleChats()`.

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

| call | no index, 3 chats | index, 3 chats | index, 100 k chats |
|---|---|---|---|
| `pull(1)` | 405 878 – 511 630 | first 140, then 1.5 – 7.4, median 2.1 | first 398, then 124 – 190, median 144 |
| `pull(30)` | — | first 5, then 3.6 – 28, median 7.0, for 3 messages | first 131, then 134 – 536, median 228, for 30 messages |
| `markAsDone()` | 72 – 76 | median 2.1, p95 4.1, max 14 | median 1.2, p95 4.3, max 42 |
| `findExpiredLeases()`, no lease expired | — | 0.7 | 3.1 |
| `findExpiredLeases()`, a batch expired | — | 706, 3 leases | 22, 30 leases |
| `deleteFinishedMessages()`, a full batch | — | 4.6 – 54, one of 86 063 | — |
| `deleteFinishedMessages()`, nothing to delete | — | 81 462 | 118 604 |
| `deleteIdleChats()` | — | 32 | 60 |

Without an index only two pulls and their completions were measured, of an earlier fill and with the
plans on: each pull took minutes, and the rest of the run would have taken hours. The index is
`telegram_outbox (chat_id, id) WHERE status IN ('pending', 'processing')`, made then by hand over
the filled table, where it took 2 minutes to build; it is now the migration
`1791153270752_telegram-outbox-head-index.ts`. The plans add to the time: `pull(1)` of 100 k chats
took a median of 161 ms with them and 144 ms without.

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

### The lease recovery with the index

`findExpiredLeases()` finds the `processing` message of each expired chat among all the active
messages of the chat: the index gives them by chat, and the status is a filter over every one of
them, with no `LIMIT` to stop at the head, where the message is. So it costs as many rows as the
chats it recovers have active messages: 300 000 a chat in the 3 chats layout.

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

A message leaves two dead entries in the candidate index: its `status` is in the index predicate, so
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

The migration sets three options of `telegram_outbox`: `vacuum_index_cleanup = on`, so a vacuum
never skips the indexes, and `autovacuum_vacuum_scale_factor = 0` with
`autovacuum_vacuum_threshold = 100000`, so autovacuum comes after 100 000 dead rows, whatever the
size of the done history. The dead entries a head lookup walks are those of its own chat, so the
worst case is one chat that sends all of them: `make load-churn chat=1 messages=45000` over the 3
chats layout, each message pulled and completed in transactions of its own, as the store does,
leaves 90 000 dead rows, all of chat 1, just under the threshold. Its head lookup then read 180
buffers in 0.36 ms, warm, against 11 after 1 000 messages: some 500 dead entries a page.

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
hours to reach the threshold, with the 180 buffers above at the end.

The same churn with `vacuum_index_cleanup` back at its default, `auto`, shows why the option is
there: autovacuum came on the threshold as well, but skipped the indexes, and the dead entries
stayed for the next lookups to walk, 203 buffers, growing with every message after it:

```
automatic vacuum of table "docker_db.public.telegram_outbox": index scans: 0
	index scan bypassed: 4935 pages from table (0.05% of total) have 102000 dead item identifiers
	index "telegram_outbox_active_chat_id_idx": pages: 3473 in total, 0 newly deleted, 196 currently deleted, 196 reusable
	system usage: CPU: user: 0.15 s, system: 0.01 s, elapsed: 0.44 s
```

The runs are logged by `log_autovacuum_min_duration = 0` of `docker-compose.load.yml`, and
`make load-measure` prints them with the plans.

### The cleanup

`deleteFinishedMessages()` filters on `finished_at` plus the retention, which no index on
`finished_at` serves, so the call that finds nothing reads the whole table, every
`OUTBOX_MAINTENANCE_CLEANUP_INTERVAL` on every node. It does not hold the bot row or the chats, but
it is one statement, and for the whole of its run it holds its snapshot: no vacuum removes the row
versions, and the dead entries of the index with them, that the pulls and the completions leave
meanwhile. So the cleanup adds to the dead entries above, besides the disk it reads.

```
Seq Scan on telegram_outbox telegram_outbox_1  (actual time=114548.029..114548.029 rows=0.00 loops=1)
  Filter: (((status = 'done'::text) AND ((finished_at + '168:00:00'::interval) < now())) OR ...)
  Buffers: shared hit=6113 read=9132300 dirtied=6
```

A batch finds its rows fast only while they lie where the scan starts. The full batches are of the 3
chats run, the first after the fill and the only one with rows past the retention, which lie at the
start of the table: four took 4.6 – 54 ms, and one 86 s. In an earlier run with the plans on, such a
batch showed its scan passing 100.9 M rows before them. A seq scan of a table this large need not
start at the first page: with `synchronize_seqscans`, on by default, it starts where the last scan
of the table reported it was.

## Verdict

With the candidate index the completion is within the threshold at its median, 1 – 2 ms, and at its
95th percentile, 4 ms, though not at its maximum, 14 and 42 ms. So is the pull of a few chats at its
median, 2 – 7 ms, while the index is kept clean of dead entries; a batch of the 3 chats took up to
28 ms once. The pull of 100 k ready chats is not: a batch takes a median of 228 ms, some 23 times
over, and the pull of one message 144 ms. The threshold is not set for the lease recovery and the
cleanup, which hold neither the bot row nor a caller waiting: the lease recovery takes 1 – 3 ms
while no lease has expired and 706 ms for the 3 chats of 300 000 messages whose leases have, and the
cleanup that finds nothing reads the whole table for 81 – 119 s. The proposal is a comment on #643:
https://github.com/yuldashevsardor/telegram-bot/issues/643#issuecomment-5984131010
