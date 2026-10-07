-- The done updates of the inbox load test (docs/architecture/inbox-load-test.md): :rows updates over
-- the groups 1 to :groups, the handled history the claim and the completion have to find their way
-- past. Run by make load-inbox-fill-done, once: the pending layouts are swapped over them.
--
-- A group is a private chat, so its user and its chat are the same id. Each update is a font sent
-- as a document, what the bot gets most. Its update_id is its number in the fill, so the done
-- updates come first by update_id, as the handled history does.
--
-- The oldest :rows / 20 000 updates, 5 000 of 100 M, finished past INBOX_DONE_RETENTION, the rest
-- within the day before the fill, as in outbox-fill-done.sql and for the same reasons: the cleanup
-- has a few full batches to delete and then the call that finds nothing, and the fill stays valid
-- for 6 days. The windows, 8 days and 1 day, are for the retention of .env.dist, 7 days.
--
-- The status is the value of InboxStatus.Done. Nothing checks it: with another value the cleanup
-- of the measurement finds nothing to delete, the full batches included.

-- A second fill would collide with the update_id of the first.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM telegram_inbox) THEN
        RAISE EXCEPTION 'telegram_inbox is filled already: make load-down and make load-up give an empty one';
    END IF;
END
$$;

INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status, attempts, created_at, updated_at, finished_at)
SELECT n,
       group_id,
       group_id,
       jsonb_build_object(
           'update_id', n,
           'message', jsonb_build_object(
               'message_id', n,
               'date', extract(epoch FROM finished_at)::bigint - 1,
               'chat', jsonb_build_object('id', group_id, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', group_id, 'is_bot', false, 'first_name', 'User', 'language_code', 'ru'),
               'document', jsonb_build_object(
                   'file_name', 'font-' || n || '.ttf',
                   'mime_type', 'font/ttf',
                   'file_id', 'BQACAgIAAxkBAAIBY2Zk' || md5(n::text),
                   'file_unique_id', 'AgAD' || left(md5(n::text), 12),
                   'file_size', 100000 + n % 400000
               )
           )
       ),
       'done',
       jsonb_build_array(jsonb_build_object(
           'started_at', finished_at - interval '2 seconds',
           'finished_at', finished_at,
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', 'inbox'),
           'error', NULL
       )),
       finished_at - interval '3 seconds',
       finished_at,
       finished_at
FROM (
    SELECT n,
           1 + n % :groups AS group_id,
           CASE
               WHEN n <= :rows / 20000 THEN now() - interval '8 days'
               ELSE now() - interval '1 day' + n * (interval '1 day' / :rows)
           END AS finished_at
    FROM generate_series(1, :rows) AS n
) AS inbox_update;

VACUUM (ANALYZE) telegram_inbox;
