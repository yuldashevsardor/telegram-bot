-- The done messages of the outbox load test (docs/architecture/outbox.md, "Load test"): :rows rows
-- over the chats 1 to :chats, the sent history the pull and the completion have to find their way
-- past. Run by make load-fill-done, once: the pending layouts are swapped over them.
--
-- The oldest :rows / 20 000 rows, 5 000 of 100 M, finished past OUTBOX_DONE_RETENTION, the rest
-- within the day before the fill: the cleanup has a few full batches to delete, and then the call that finds
-- nothing, which is what a cleanup that keeps up finds every OUTBOX_MAINTENANCE_CLEANUP_INTERVAL.
-- The day keeps the fill valid for 6 days: after that its rows pass the retention, and the cleanup
-- of a measurement deletes them by the thousand. The expired rows are inserted first, so they lie
-- at the start of the table, as the oldest rows do.
--
-- The windows, 8 days and 1 day, are for the retention of .env.dist, 7 days.
--
-- The status is the value of OutboxStatus.Done. Nothing checks it: with another value the cleanup
-- of the measurement finds nothing to delete, the full batches included.

-- A second fill would add another :rows rows after the first, its expired ones in the middle of the
-- table.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM telegram_outbox) THEN
        RAISE EXCEPTION 'telegram_outbox is filled already: make load-down and make load-up give an empty one';
    END IF;
END
$$;

INSERT INTO telegram_outbox (chat_id, method, payload, priority, status, attempts, response, created_at, updated_at, finished_at)
SELECT chat_id,
       'sendMessage',
       jsonb_build_object('chat_id', chat_id, 'text', 'Font ' || n || ' is converted: woff2 and ttf are attached below.'),
       0,
       'done',
       jsonb_build_array(jsonb_build_object(
           'started_at', finished_at - interval '200 milliseconds',
           'finished_at', finished_at,
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', n % 5),
           'error', NULL
       )),
       jsonb_build_object(
           'message_id', n,
           'date', extract(epoch FROM finished_at)::bigint,
           'chat', jsonb_build_object('id', chat_id, 'type', 'private', 'first_name', 'User'),
           'from', jsonb_build_object('id', 1000000001, 'is_bot', true, 'first_name', 'Font bot', 'username', 'font_bot'),
           'text', 'Font ' || n || ' is converted: woff2 and ttf are attached below.'
       ),
       finished_at - interval '1 second',
       finished_at,
       finished_at
FROM (
    SELECT n,
           1 + n % :chats AS chat_id,
           CASE
               WHEN n <= :rows / 20000 THEN now() - interval '8 days'
               ELSE now() - interval '1 day' + n * (interval '1 day' / :rows)
           END AS finished_at
    FROM generate_series(1, :rows) AS n
) AS message;

VACUUM (ANALYZE) telegram_outbox;
