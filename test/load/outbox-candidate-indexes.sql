-- The candidate indexes of the outbox load test (docs/architecture/outbox.md, "Load test"), made by
-- make load-indexes: the measurement with them is what the proposal of
-- https://github.com/yuldashevsardor/telegram-bot/issues/643 rests on. Not a migration: the
-- migration is that issue.

-- The head of a chat (pull), the active message left behind a completed one (releaseChat()) and the
-- processing message of an expired lease (findExpiredLeases()) are each the first rows of one chat
-- among the active statuses. Partial: the active messages are a sliver of the table, the done ones
-- are the bulk, and none of these queries reads them.
CREATE INDEX IF NOT EXISTS telegram_outbox_active_chat_id_idx
    ON telegram_outbox (chat_id, id)
    WHERE status IN ('pending', 'processing');

ANALYZE telegram_outbox;
