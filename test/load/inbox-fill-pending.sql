-- A pending layout of the inbox load test (docs/architecture/inbox-load-test.md) over the history of
-- inbox-fill-done.sql: :updates pending updates over the groups by the skew of the history, and
-- :hot_updates more in group 1. Run by make load-inbox-fill-pending; it replaces what the previous
-- layout and its measurement left.
--
-- A pending update goes to the group of a history update drawn by a hash of its number, so a group
-- gets pending updates in proportion to its history, and the heavy groups get the most. The draw
-- leaves out the oldest updates, one in :expired_one_in as inbox-fill-done.sql dates them, which the
-- cleanup of a measurement deletes.
--
-- Every thousandth group of the 1 M of the default fill, 1 000 in all, is blocked by a failed update
-- newer than its history, so countBlockedGroups() has groups to count; a fill of fewer groups leaves
-- most of them without history. The pending updates the draw gives such a group wait behind it, as
-- the pushes to a blocked group do.
--
-- The status and the state are the values of InboxStatus and InboxGroupState; the measurement stops
-- on a layout it cannot claim (inbox-load-test.ts).

-- The update_id of a layout start far past the history, so the next layout deletes all that this
-- one and its measurement wrote by update_id alone: the updates the measurement completed, failed or
-- skipped included.
\set layout_first_update_id 1000000000000
\set blocked_group_count 1000
\set blocked_group_spacing 1000

-- A layout without the history would have no groups to draw.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM telegram_inbox WHERE status = 'done') THEN
        RAISE EXCEPTION 'telegram_inbox has no done updates: make load-inbox-fill-done first';
    END IF;
END
$$;

SELECT max(update_id) AS history_update_count
FROM telegram_inbox
WHERE update_id < :layout_first_update_id
\gset

-- The groups of the pending updates, drawn ahead of the layout so that the check below sees them.
CREATE TEMPORARY TABLE inbox_pending_draw AS
SELECT pending_number,
       history_update.user_id AS group_id
FROM generate_series(1, :updates::bigint) AS pending_number
JOIN telegram_inbox AS history_update
  ON history_update.update_id = :history_update_count / :expired_one_in + 1
                                + abs(hashint8extended(pending_number, 4) % (:history_update_count - :history_update_count / :expired_one_in));

-- A drawn history update that is gone drops its pending update: on a fill past
-- INBOX_DONE_RETENTION the cleanup of a measurement deletes updates inside the drawn range. The
-- check comes before the previous layout is deleted: the delete, the inserts and the vacuum after
-- them take most of the time of a layout.
SELECT count(*) <> :updates AS is_layout_short
FROM inbox_pending_draw
\gset

\if :is_layout_short
DO $$
BEGIN
    RAISE EXCEPTION 'the layout lost pending updates to deleted history: the fill is past INBOX_DONE_RETENTION, make load-down, load-up and a new fill';
END
$$;
\endif

BEGIN;

DELETE FROM telegram_inbox WHERE update_id >= :layout_first_update_id;
DELETE FROM telegram_inbox_groups;

INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status, attempts, updated_at, finished_at)
SELECT :layout_first_update_id + blocked_number,
       blocked_number * :blocked_group_spacing,
       blocked_number * :blocked_group_spacing,
       jsonb_build_object(
           'update_id', :layout_first_update_id + blocked_number,
           'message', jsonb_build_object(
               'message_id', blocked_number,
               'date', extract(epoch FROM now())::bigint,
               'chat', jsonb_build_object('id', blocked_number * :blocked_group_spacing, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', blocked_number * :blocked_group_spacing, 'is_bot', false, 'first_name', 'User', 'language_code', 'ru'),
               'document', jsonb_build_object(
                   'file_name', 'font-blocked-' || blocked_number || '.ttf',
                   'mime_type', 'font/ttf',
                   'file_id', 'BQACAgIAAxkBAAIBY2Zk' || md5('blocked-' || blocked_number),
                   'file_unique_id', 'AgAD' || left(md5('blocked-' || blocked_number), 12),
                   'file_size', 100000 + blocked_number
               )
           )
       ),
       'failed',
       jsonb_build_array(jsonb_build_object(
           'started_at', now() - interval '2 seconds',
           'finished_at', now(),
           'worker', jsonb_build_object('host', 'bot-node-1', 'pid', 42, 'worker_id', 'inbox'),
           'error', jsonb_build_object(
               'kind', 'unexpected',
               'name', 'RuntimeError',
               'message', 'The font could not be converted',
               'stack', 'RuntimeError: The font could not be converted' || chr(10) || '    at FontConvertor.convert (/app/src/font-convertor/font-convertor.ts:42:15)'
           )
       )),
       now(),
       now()
FROM generate_series(1, :blocked_group_count) AS blocked_number
ORDER BY blocked_number;

-- The update_id follow the order of the draws, so the updates of a group lie apart from each other,
-- as updates that came over time from many groups do.
INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status)
SELECT update_id,
       group_id,
       group_id,
       jsonb_build_object(
           'update_id', update_id,
           'message', jsonb_build_object(
               'message_id', pending_number,
               'date', extract(epoch FROM now())::bigint,
               'chat', jsonb_build_object('id', group_id, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', group_id, 'is_bot', false, 'first_name', 'User', 'language_code', 'ru'),
               'document', jsonb_build_object(
                   'file_name', 'font-' || update_id || '.ttf',
                   'mime_type', 'font/ttf',
                   'file_id', 'BQACAgIAAxkBAAIBY2Zk' || md5(update_id::text),
                   'file_unique_id', 'AgAD' || left(md5(update_id::text), 12),
                   'file_size', 100000 + update_id % 400000
               )
           )
       ),
       'pending'
FROM (
    SELECT :layout_first_update_id + :blocked_group_count + pending_number AS update_id,
           pending_number,
           group_id
    FROM inbox_pending_draw
) AS inbox_update
ORDER BY update_id;

INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status)
SELECT update_id,
       1,
       1,
       jsonb_build_object(
           'update_id', update_id,
           'message', jsonb_build_object(
               'message_id', hot_number,
               'date', extract(epoch FROM now())::bigint,
               'chat', jsonb_build_object('id', 1, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', 1, 'is_bot', false, 'first_name', 'User', 'language_code', 'ru'),
               'document', jsonb_build_object(
                   'file_name', 'font-' || update_id || '.ttf',
                   'mime_type', 'font/ttf',
                   'file_id', 'BQACAgIAAxkBAAIBY2Zk' || md5(update_id::text),
                   'file_unique_id', 'AgAD' || left(md5(update_id::text), 12),
                   'file_size', 100000 + update_id % 400000
               )
           )
       ),
       'pending'
FROM (
    SELECT :layout_first_update_id + :blocked_group_count + :updates + hot_number AS update_id, hot_number
    FROM generate_series(1, :hot_updates::bigint) AS hot_number
) AS inbox_update
ORDER BY update_id;

-- A group with the failed update of the layout is blocked, every other group of the layout is ready.
INSERT INTO telegram_inbox_groups (user_id, chat_id, state, next_attempt_at)
SELECT user_id,
       chat_id,
       CASE WHEN bool_or(status = 'failed') THEN 'blocked' ELSE 'ready' END,
       now() - interval '1 minute'
FROM telegram_inbox
WHERE update_id >= :layout_first_update_id
GROUP BY user_id, chat_id;

COMMIT;

-- The deleted layout leaves its entries in the indexes, as the layouts of the outbox do
-- (docs/architecture/outbox-load-test.md, "Dead entries of the index"): INDEX_CLEANUP ON cleans
-- them, where a plain VACUUM skips the indexes while the dead rows lie on less than 2% of the pages.
VACUUM (ANALYZE, INDEX_CLEANUP ON) telegram_inbox, telegram_inbox_groups;
