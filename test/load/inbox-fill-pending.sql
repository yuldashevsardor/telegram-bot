-- A pending layout of the inbox load test (docs/architecture/inbox-load-test.md): :groups ready
-- groups, 1 to :groups, with :per_group pending updates each, over the done updates of
-- inbox-fill-done.sql. Run by make load-inbox-fill-pending; it replaces the active updates and the
-- groups the previous run left. The updates the measurement completed stay among the done ones: a
-- few hundred against the 100 M of the fill.
--
-- The status and the state are the values of InboxStatus and InboxGroupState; the measurement stops
-- on a layout it cannot claim (inbox-load-test.ts).

BEGIN;

DELETE FROM telegram_inbox WHERE status <> 'done';
DELETE FROM telegram_inbox_groups;

-- The update_id follow the done ones, and the updates of a group lie apart from each other, as
-- updates that came over time from many groups do: the inner loop is the group.
INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status)
SELECT update_id,
       group_id,
       group_id,
       jsonb_build_object(
           'update_id', update_id,
           'message', jsonb_build_object(
               'message_id', position,
               'date', extract(epoch FROM now())::bigint,
               'chat', jsonb_build_object('id', group_id, 'type', 'private', 'first_name', 'User'),
               'from', jsonb_build_object('id', group_id, 'is_bot', false, 'first_name', 'User', 'language_code', 'ru'),
               'document', jsonb_build_object(
                   'file_name', 'font-' || position || '.ttf',
                   'mime_type', 'font/ttf',
                   'file_id', 'BQACAgIAAxkBAAIBY2Zk' || md5(update_id::text),
                   'file_unique_id', 'AgAD' || left(md5(update_id::text), 12),
                   'file_size', 100000 + update_id % 400000
               )
           )
       ),
       'pending'
FROM (
    SELECT done.last_update_id + row_number() OVER (ORDER BY position, group_id) AS update_id, position, group_id
    FROM generate_series(1, :per_group) AS position
    CROSS JOIN generate_series(1, :groups) AS group_id
    CROSS JOIN (SELECT max(update_id) AS last_update_id FROM telegram_inbox) AS done
) AS inbox_update
ORDER BY update_id;

INSERT INTO telegram_inbox_groups (user_id, chat_id, state, next_attempt_at)
SELECT group_id, group_id, 'ready', now() - interval '1 minute'
FROM generate_series(1, :groups) AS group_id;

COMMIT;

-- The deleted layout leaves its entries in the indexes, as the layouts of the outbox do
-- (docs/architecture/outbox-load-test.md, "Dead entries of the index"): INDEX_CLEANUP ON cleans
-- them, where a plain VACUUM skips the indexes while the dead rows lie on less than 2% of the pages.
VACUUM (ANALYZE, INDEX_CLEANUP ON) telegram_inbox, telegram_inbox_groups;
