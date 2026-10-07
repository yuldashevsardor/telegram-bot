-- A pending layout of the outbox load test (docs/architecture/outbox-load-test.md): :chats ready
-- chats, 1 to :chats, with :per_chat pending messages each, over the done messages of
-- outbox-fill-done.sql. Run by make load-fill-pending; it replaces the pending messages and the
-- chats the previous run left, and puts the bot row back to a full budget. The messages the
-- measurement completed stay among the done ones: a few hundred against the 100 M of the fill.
--
-- The status and the state are the values of OutboxStatus and OutboxChatState; the measurement
-- stops on a layout it cannot pull (outbox-load-test.ts).

BEGIN;

DELETE FROM telegram_outbox WHERE status <> 'done';
DELETE FROM telegram_outbox_chats;

-- The messages of a chat lie apart from each other, as messages pushed over time by many chats do:
-- the inner loop is the chat.
INSERT INTO telegram_outbox (chat_id, method, payload, priority, status)
SELECT chat_id,
       'sendMessage',
       jsonb_build_object('chat_id', chat_id, 'text', 'Font ' || position || ' is converted: woff2 and ttf are attached below.'),
       0,
       'pending'
FROM generate_series(1, :per_chat) AS position
CROSS JOIN generate_series(1, :chats) AS chat_id
ORDER BY position, chat_id;

-- head_priority is the copy of the priority of the head that the store keeps (outbox-store.ts).
INSERT INTO telegram_outbox_chats (chat_id, state, next_attempt_at, head_priority)
SELECT chat_id, 'ready', now() - interval '1 minute', 0
FROM generate_series(1, :chats) AS chat_id;

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
