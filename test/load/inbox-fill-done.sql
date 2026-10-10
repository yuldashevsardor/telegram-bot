-- The handled history of the inbox load test (docs/architecture/inbox-load-test.md): about :rows
-- updates over the groups 1 to :groups, skewed as production traffic is, the history the claim, the
-- completion and the cleanup have to find their way past. Run by make load-inbox-fill-done, once:
-- the pending layouts are swapped over it.
--
-- A group is a private chat, so its user and its chat are the same id. Each update is a font sent
-- as a document, what the bot gets most. Its update_id is its number in the fill, so the history
-- comes first by update_id, as the handled history does.
--
-- The updates of a group are drawn by the shape of #871 and scaled so that their sum comes to about
-- :rows. The draws are hashes of the group id and of the update number, not random(), so a rerun of
-- the fill gives the same rows and the runs compare.
--
-- The groups are interleaved in time: update n goes to the group that holds position a * n mod N
-- among the N positions, each group a run of positions as long as its updates. With a coprime to N
-- every position is taken once, and with a near N times the golden ratio the positions of a group
-- are reached by numbers spread over the whole history, not one after another. The order needs no
-- sort of the N rows: the inserts go in update_id order, so the table lies in it as well.
--
-- One update in 200 failed and one in 200 was skipped. The oldest N / :expired_one_in updates,
-- 12 500 of 250 M at the 20 000 of the Makefile, finished past their retention, the rest within the
-- day before the fill, as in outbox-fill-done.sql and for the same reasons: the cleanup has a few
-- full batches to delete and then the call that finds nothing, and the fill stays valid for 6 days.
-- The windows are for the retentions of .env.dist: done and failed 8 days back against
-- INBOX_DONE_RETENTION of 7, skipped 31 against INBOX_SKIPPED_RETENTION of 30. A failed update is
-- never deleted, whatever its age.
--
-- The statuses are the values of InboxStatus. Nothing checks them: with another value the cleanup of
-- the measurement finds nothing to delete, the full batches included.

-- A second fill would collide with the update_id of the first.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM telegram_inbox) THEN
        RAISE EXCEPTION 'telegram_inbox is filled already: TRUNCATE telegram_inbox, telegram_inbox_groups in make load-psql empties it';
    END IF;
END
$$;

-- The groups with their runs of positions, some 60 MB at 1 M groups, are read once per update, so
-- they are kept in the memory of the session rather than in the 8 MB of temp buffers by default. Set
-- before the first temporary table of the session, as PostgreSQL requires.
SET temp_buffers = '256MB';

-- The shape of #871: the share of the groups and the updates each of them has, before the scaling.
CREATE TEMPORARY TABLE inbox_fill_group AS
WITH drawn_group AS (
    SELECT group_id,
           abs(hashint8extended(group_id, 1) % 1000000) / 1000000.0 AS size_class_draw,
           abs(hashint8extended(group_id, 2) % 1000000) / 1000000.0 AS size_draw
    FROM generate_series(1, :groups::bigint) AS group_id
),
sized_group AS (
    SELECT group_id,
           CASE
               WHEN size_class_draw < 0.60 THEN 1 + floor(size_draw * 50)
               WHEN size_class_draw < 0.90 THEN 51 + floor(size_draw * 450)
               WHEN size_class_draw < 0.99 THEN 501 + floor(size_draw * 1500)
               ELSE 2001 + floor(size_draw * 8000)
           END AS drawn_update_count
    FROM drawn_group
),
scaled_group AS (
    SELECT group_id,
           greatest(1, round(drawn_update_count * :rows / sum(drawn_update_count) OVER ()))::bigint AS update_count
    FROM sized_group
)
SELECT group_id,
       update_count,
       sum(update_count) OVER (ORDER BY group_id) - update_count AS first_position
FROM scaled_group;

CREATE UNIQUE INDEX ON inbox_fill_group (first_position);
ANALYZE inbox_fill_group;

SELECT sum(update_count) AS update_count FROM inbox_fill_group
\gset

SELECT min(candidate) AS multiplier
FROM generate_series(round(:update_count * 0.6180339887)::bigint, round(:update_count * 0.6180339887)::bigint + 1000) AS candidate
WHERE gcd(candidate, :update_count::bigint) = 1
\gset

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
       status,
       jsonb_build_array(jsonb_build_object(
           'started_at', finished_at - interval '2 seconds',
           'finished_at', finished_at,
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', 'inbox'),
           'error', CASE
               WHEN status = 'done' THEN NULL
               ELSE jsonb_build_object(
                   'kind', 'unexpected',
                   'name', 'RuntimeError',
                   'message', 'The font could not be converted',
                   'stack', 'RuntimeError: The font could not be converted' || chr(10) || '    at FontConvertor.convert (/app/src/font-convertor/font-convertor.ts:42:15)'
               )
           END
       )),
       finished_at - interval '3 seconds',
       finished_at,
       finished_at
FROM (
    SELECT n,
           inbox_group.group_id,
           inbox_update_status.status,
           CASE
               WHEN n > :update_count / :expired_one_in THEN now() - interval '1 day' + n * (interval '1 day' / :update_count)
               WHEN inbox_update_status.status = 'skipped' THEN now() - interval '31 days'
               ELSE now() - interval '8 days'
           END AS finished_at
    FROM generate_series(1, :update_count::bigint) AS n
    CROSS JOIN LATERAL (
        SELECT group_id
        FROM inbox_fill_group
        WHERE first_position <= :multiplier::bigint * n % :update_count
        ORDER BY first_position DESC
        LIMIT 1
    ) AS inbox_group
    CROSS JOIN LATERAL (
        SELECT CASE abs(hashint8extended(n, 3) % 200)
                   WHEN 0 THEN 'failed'
                   WHEN 1 THEN 'skipped'
                   ELSE 'done'
               END AS status
    ) AS inbox_update_status
) AS inbox_update;

VACUUM (ANALYZE) telegram_inbox;
