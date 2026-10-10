-- The sent history of the outbox load test (docs/architecture/outbox-load-test.md): about :rows
-- messages over the chats 1 to :chats, skewed as production traffic is, the history the pull, the
-- completion and the cleanup have to find their way past. Run by make load-fill-done, once: the
-- pending layouts are swapped over it.
--
-- Each message is a reply of the bot in a private chat. Its id comes from the identity in the order
-- of the numbers of the fill, so the history comes first by id, as the sent history does.
--
-- The messages of a chat are drawn by the shape of #872, that of the inbox load test of #871, and
-- scaled so that their sum comes to about :rows. The draws are hashes of the chat id and of the
-- message number, not random(), so a rerun of the fill gives the same rows and the runs compare.
--
-- The chats are interleaved in time as the groups of inbox-fill-done.sql are: message n goes to the
-- chat that holds position a * n mod N among the N positions, each chat a run of positions as long
-- as its messages. With a coprime to N every position is taken once, and with a near N times the
-- golden ratio the positions of a chat are reached by numbers spread over the whole history, not one
-- after another. The order needs no sort of the N rows: the inserts go in id order, so the table
-- lies in it as well.
--
-- One message in 200 failed and one in 200 was skipped. The oldest N / 20 000 messages, 14 000 of
-- 280 M, finished past their retention, the rest within the day before the fill: the cleanup has a
-- few full batches to delete and then the call that finds nothing, which is what a cleanup that
-- keeps up finds every OUTBOX_MAINTENANCE_CLEANUP_INTERVAL. The day keeps the fill valid for 6 days:
-- after that its rows pass the retention, and the cleanup of a measurement deletes them by the
-- thousand. The windows are for the retentions of .env.dist: done and failed 8 days back against
-- OUTBOX_DONE_RETENTION of 7, skipped 31 against OUTBOX_SKIPPED_RETENTION of 30. A failed message is
-- never deleted, whatever its age.
--
-- The statuses are the values of OutboxStatus, the priority that of OutboxPriority.Call, the one the
-- replies of the bot are pushed with. Nothing checks them: with another status the cleanup of the
-- measurement finds nothing to delete, the full batches included.

-- A second fill would add another :rows rows after the first, its expired ones in the middle of the
-- table. Emptied, the table keeps its identity where the last layout moved it, past the ids of the
-- layouts (outbox-fill-pending.sql), so RESTART IDENTITY starts the history at 1 again.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM telegram_outbox) THEN
        RAISE EXCEPTION 'telegram_outbox is filled already: TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY in make load-psql empties it';
    END IF;
END
$$;

-- The chats with their runs of positions, some 60 MB at 1 M chats, are read once per message, so
-- they are kept in the memory of the session rather than in the 8 MB of temp buffers by default. Set
-- before the first temporary table of the session, as PostgreSQL requires.
SET temp_buffers = '256MB';

-- The shape of #872: the share of the chats and the messages each of them has, before the scaling.
CREATE TEMPORARY TABLE outbox_fill_chat AS
WITH drawn_chat AS (
    SELECT chat_id,
           abs(hashint8extended(chat_id, 1) % 1000000) / 1000000.0 AS size_class_draw,
           abs(hashint8extended(chat_id, 2) % 1000000) / 1000000.0 AS size_draw
    FROM generate_series(1, :chats::bigint) AS chat_id
),
sized_chat AS (
    SELECT chat_id,
           CASE
               WHEN size_class_draw < 0.60 THEN 1 + floor(size_draw * 50)
               WHEN size_class_draw < 0.90 THEN 51 + floor(size_draw * 450)
               WHEN size_class_draw < 0.99 THEN 501 + floor(size_draw * 1500)
               ELSE 2001 + floor(size_draw * 8000)
           END AS drawn_message_count
    FROM drawn_chat
),
scaled_chat AS (
    SELECT chat_id,
           greatest(1, round(drawn_message_count * :rows / sum(drawn_message_count) OVER ()))::bigint AS message_count
    FROM sized_chat
)
SELECT chat_id,
       message_count,
       (sum(message_count) OVER (ORDER BY chat_id) - message_count)::bigint AS first_position
FROM scaled_chat;

CREATE UNIQUE INDEX ON outbox_fill_chat (first_position);
ANALYZE outbox_fill_chat;

SELECT sum(message_count)::bigint AS message_count FROM outbox_fill_chat
\gset

\set golden_ratio_fraction 0.6180339887

SELECT round(:message_count * :golden_ratio_fraction)::bigint AS multiplier_from
\gset

SELECT min(candidate) AS multiplier
FROM generate_series(:multiplier_from, :multiplier_from + 1000) AS candidate
WHERE gcd(candidate, :message_count::bigint) = 1
\gset

-- The error of an attempt is a GrammyError as OutboxErrorSerializer writes it: a failed message
-- went to a chat that blocked the bot, which fails a message without blocking the chat, and a skipped
-- one failed in a way that blocks it, so it was skipped by hand. A done message has the response of
-- the call.
INSERT INTO telegram_outbox (chat_id, method, payload, priority, status, attempts, response, created_at, updated_at, finished_at)
SELECT chat_id,
       'sendMessage',
       jsonb_build_object('chat_id', chat_id, 'text', 'Font ' || n || ' is converted: woff2 and ttf are attached below.'),
       100,
       status,
       jsonb_build_array(jsonb_build_object(
           'started_at', finished_at - interval '200 milliseconds',
           'finished_at', finished_at,
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', 'outbox'),
           'error', CASE status
               WHEN 'failed' THEN jsonb_build_object(
                   'kind', 'undeliverable',
                   'name', 'GrammyError',
                   'message', 'Call to ''sendMessage'' failed! (403: Forbidden: bot was blocked by the user)',
                   'error_code', 403,
                   'description', 'Forbidden: bot was blocked by the user',
                   'method', 'sendMessage'
               )
               WHEN 'skipped' THEN jsonb_build_object(
                   'kind', 'unexpected',
                   'name', 'GrammyError',
                   'message', 'Call to ''sendMessage'' failed! (400: Bad Request: can''t parse entities)',
                   'error_code', 400,
                   'description', 'Bad Request: can''t parse entities',
                   'method', 'sendMessage'
               )
           END
       )),
       CASE
           WHEN status = 'done' THEN jsonb_build_object(
               'message_id', n,
               'date', extract(epoch FROM finished_at)::bigint,
               'chat', jsonb_build_object('id', chat_id, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', 1000000001, 'is_bot', true, 'first_name', 'Font bot', 'username', 'font_bot'),
               'text', 'Font ' || n || ' is converted: woff2 and ttf are attached below.'
           )
       END,
       finished_at - interval '1 second',
       finished_at,
       finished_at
FROM (
    SELECT n,
           outbox_chat.chat_id,
           outbox_message_status.status,
           CASE
               WHEN n > :message_count / 20000 THEN now() - interval '1 day' + interval '1 day' * n / :message_count
               WHEN outbox_message_status.status = 'skipped' THEN now() - interval '31 days'
               ELSE now() - interval '8 days'
           END AS finished_at
    FROM generate_series(1, :message_count::bigint) AS n
    CROSS JOIN LATERAL (
        SELECT chat_id
        FROM outbox_fill_chat
        WHERE first_position <= :multiplier::bigint * n % :message_count
        ORDER BY first_position DESC
        LIMIT 1
    ) AS outbox_chat
    CROSS JOIN LATERAL (
        SELECT CASE abs(hashint8extended(n, 3) % 200)
                   WHEN 0 THEN 'failed'
                   WHEN 1 THEN 'skipped'
                   ELSE 'done'
               END AS status
    ) AS outbox_message_status
) AS outbox_message;

VACUUM (ANALYZE) telegram_outbox;
