-- The dead entries of the head index (docs/architecture/outbox-load-test.md, "Vacuum of the head
-- index"): sends the :messages oldest active messages of chat :chat as a pull and a completion would,
-- then prints the dead rows of the table and the plan of the head lookup of the chat. Run by make
-- load-churn over a layout of make load-fill-pending.
--
-- Each message is pulled and completed in a transaction of its own, as the store does: the version
-- each leaves is dead to every snapshot once it commits, which is what lets an insert into a full
-- page of the index delete the dead entries on it before it splits the page. A batch of messages per
-- statement would keep them visible to the statement and leave more behind. The limits are not
-- kept: the dead entries depend on the number of messages sent, not on the time it took.
--
-- The statuses are the values of OutboxStatus.

SET load_churn.chat = :'chat';
SET load_churn.messages = :'messages';

DO $$
DECLARE
    churn_chat_id bigint := current_setting('load_churn.chat')::bigint;
    message_count integer := current_setting('load_churn.messages')::integer;
    head_id bigint;
BEGIN
    FOR sent_count IN 1..message_count LOOP
        SELECT id
        INTO head_id
        FROM telegram_outbox
        WHERE chat_id = churn_chat_id
          AND status IN ('pending', 'processing')
        ORDER BY id
        LIMIT 1;

        IF head_id IS NULL THEN
            RAISE EXCEPTION 'chat % has no active message left after % sent: make load-fill-pending gives it more', churn_chat_id, sent_count - 1;
        END IF;

        UPDATE telegram_outbox SET status = 'processing', updated_at = now() WHERE id = head_id;
        COMMIT;
        UPDATE telegram_outbox SET status = 'done', finished_at = now(), updated_at = now() WHERE id = head_id;
        COMMIT;
    END LOOP;
END
$$;

-- The statistics reach pg_stat_user_tables up to a second after the commit.
SELECT pg_sleep(1);
SELECT n_dead_tup, autovacuum_count, last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'telegram_outbox';

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM telegram_outbox
WHERE chat_id = :chat
  AND status IN ('pending', 'processing')
ORDER BY id
LIMIT 1;
