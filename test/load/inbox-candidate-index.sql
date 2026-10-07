-- The candidate head index of the inbox load test (docs/architecture/inbox-load-test.md), made by
-- hand over a filled table: the measurement runs once without it, once with it. The head of a group
-- is its first active update by update_id, so the index holds the active updates alone, by group
-- and update_id, as telegram_outbox_active_chat_id_idx holds the active messages of a chat.
-- make load-inbox-index runs it; DROP INDEX telegram_inbox_active_group_idx in make load-psql takes
-- it away again.
--
-- The statuses are the values of InboxStatus.Pending and InboxStatus.Processing.

CREATE INDEX IF NOT EXISTS telegram_inbox_active_group_idx
    ON telegram_inbox (user_id, chat_id, update_id)
    WHERE status IN ('pending', 'processing');

ANALYZE telegram_inbox;
