-- A pending layout of the outbox load test (docs/architecture/outbox-load-test.md) over the history
-- of outbox-fill-done.sql: :messages pending messages over the chats by the skew of the history, and
-- :hot_messages more in chat 1. Run by make load-fill-pending; it replaces what the previous layout
-- and its measurement left, and puts the bot row back to a full budget.
--
-- A pending message goes to the chat of the first history message from an id drawn by a hash of its
-- number, so a chat gets pending messages in proportion to its history, the heavy chats the most,
-- and a layout filled again is the same. The first message from the id, not the message of the id:
-- the cleanup of a measurement deletes the oldest history, and the draw takes the next one.
--
-- Every thousandth chat of the 1 M of the default fill, 1 000 in all, is blocked by a failed message
-- newer than its history, so countBlockedChats() has chats to count; a fill of fewer chats leaves
-- most of them without history. The pending messages the draw gives such a chat wait behind it, as
-- the pushes to a blocked chat do.
--
-- The statuses, the states and the priority are the values of OutboxStatus, OutboxChatState and
-- OutboxPriority.Call; the measurement stops on a layout it cannot pull (outbox-load-test.ts).

-- The ids of a layout start far past the history, so the next layout deletes all that this one and
-- its measurement wrote by id alone: the messages the measurement completed, failed or skipped, and
-- those it pushed, which take their ids from the identity restarted past the layout.
\set layout_first_id 1000000000000
\set blocked_chat_count 1000
\set blocked_chat_spacing 1000

SELECT coalesce(max(id), 0) AS history_last_id
FROM telegram_outbox
WHERE id < :layout_first_id
\gset

-- A layout without the history would have no chats to draw.
SELECT :history_last_id = 0 AS has_no_history
\gset

\if :has_no_history
DO $$
BEGIN
    RAISE EXCEPTION 'telegram_outbox has no history: make load-fill-done first';
END
$$;
\endif

BEGIN;

DELETE FROM telegram_outbox WHERE id >= :layout_first_id;
DELETE FROM telegram_outbox_chats;

INSERT INTO telegram_outbox (id, chat_id, method, payload, priority, status, attempts, updated_at, finished_at)
OVERRIDING SYSTEM VALUE
SELECT :layout_first_id + blocked_number,
       blocked_number * :blocked_chat_spacing,
       'sendMessage',
       jsonb_build_object('chat_id', blocked_number * :blocked_chat_spacing, 'text', 'Font blocked-' || blocked_number || ' is converted: woff2 and ttf are attached below.'),
       100,
       'failed',
       jsonb_build_array(jsonb_build_object(
           'started_at', now() - interval '200 milliseconds',
           'finished_at', now(),
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', 'outbox'),
           'error', jsonb_build_object(
               'kind', 'unexpected',
               'name', 'GrammyError',
               'message', 'Call to ''sendMessage'' failed! (400: Bad Request: can''t parse entities)',
               'error_code', 400,
               'description', 'Bad Request: can''t parse entities',
               'method', 'sendMessage'
           )
       )),
       now(),
       now()
FROM generate_series(1, :blocked_chat_count) AS blocked_number
ORDER BY blocked_number;

-- The ids follow the order of the draws, so the messages of a chat lie apart from each other, as
-- messages pushed over time by many chats do.
INSERT INTO telegram_outbox (id, chat_id, method, payload, priority, status)
OVERRIDING SYSTEM VALUE
SELECT :layout_first_id + :blocked_chat_count + pending_number,
       history_message.chat_id,
       'sendMessage',
       jsonb_build_object('chat_id', history_message.chat_id, 'text', 'Font ' || pending_number || ' is converted: woff2 and ttf are attached below.'),
       100,
       'pending'
FROM generate_series(1, :messages::bigint) AS pending_number
CROSS JOIN LATERAL (
    SELECT chat_id
    FROM telegram_outbox
    WHERE id >= 1 + abs(hashint8extended(pending_number, 4) % :history_last_id)
    ORDER BY id
    LIMIT 1
) AS history_message
ORDER BY pending_number;

INSERT INTO telegram_outbox (id, chat_id, method, payload, priority, status)
OVERRIDING SYSTEM VALUE
SELECT :layout_first_id + :blocked_chat_count + :messages + hot_number,
       1,
       'sendMessage',
       jsonb_build_object('chat_id', 1, 'text', 'Font hot-' || hot_number || ' is converted: woff2 and ttf are attached below.'),
       100,
       'pending'
FROM generate_series(1, :hot_messages::bigint) AS hot_number
ORDER BY hot_number;

-- The pushes of the measurement go after the layout, so the next layout deletes them too.
SELECT setval(pg_get_serial_sequence('telegram_outbox', 'id'), :layout_first_id + :blocked_chat_count + :messages + :hot_messages);

-- A chat with the failed message of the layout is blocked, every other chat of the layout is ready.
-- head_priority is the copy of the priority of the head that the store keeps (outbox-store.ts), read
-- from the head as the store reads it.
INSERT INTO telegram_outbox_chats (chat_id, state, next_attempt_at, head_priority)
SELECT layout_chat.chat_id,
       layout_chat.state,
       now() - interval '1 minute',
       (
           SELECT priority
           FROM telegram_outbox
           WHERE telegram_outbox.chat_id = layout_chat.chat_id
             AND status IN ('pending', 'processing')
           ORDER BY id
           LIMIT 1
       )
FROM (
    SELECT chat_id,
           CASE WHEN bool_or(status = 'failed') THEN 'blocked' ELSE 'ready' END AS state
    FROM telegram_outbox
    WHERE id >= :layout_first_id
    GROUP BY chat_id
) AS layout_chat;

UPDATE telegram_bot_limits
SET next_send_at = now() - interval '1 hour',
    paused_until = NULL,
    updated_at = now();

COMMIT;

-- The deleted layout leaves its entries in the indexes, and the next layout would walk them to find
-- each head (docs/architecture/outbox-load-test.md, "Dead entries of the index"). telegram_outbox
-- has vacuum_index_cleanup = ON of its own, from the migration of the head index; INDEX_CLEANUP ON
-- does the same for telegram_outbox_chats, where a plain VACUUM skips the indexes while the dead
-- rows lie on less than 2% of the pages.
VACUUM (ANALYZE, INDEX_CLEANUP ON) telegram_outbox, telegram_outbox_chats;
