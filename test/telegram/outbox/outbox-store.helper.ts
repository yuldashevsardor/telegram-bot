import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { Database } from "app/platform/database/database";
import { MS_PER_HOUR } from "app/shared/time";
import type { OutboxCleanupSettings } from "app/telegram/outbox/store/outbox-store.types";

const CLEANUP_BATCH_SIZE = 10;

// The limits of the specs that are not about the limits: a cooldown of a nanosecond, below the
// microsecond of a timestamp, and a common limit no pull reaches.
export const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
export const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };

// The cleanup of the specs that are not about the cleanup: an hour of retention, longer than any
// of their messages lives, so a cleanup that runs removes none of them.
export const HOUR_RETENTION_CLEANUP: OutboxCleanupSettings = {
    doneRetentionMs: MS_PER_HOUR,
    skippedRetentionMs: MS_PER_HOUR,
    batchSize: CLEANUP_BATCH_SIZE,
};

// Empties the outbox before a test. The common limit has saved up its full number of slots, and
// there is no pause; telegram_bot_limits holds one row.
export async function resetOutbox(database: Database): Promise<void> {
    await database.sql`TRUNCATE telegram_outbox, telegram_outbox_chats RESTART IDENTITY`;
    await database.sql`
        UPDATE telegram_bot_limits
        SET next_send_at = now() - interval '1 hour',
            paused_until = NULL
    `;
}
