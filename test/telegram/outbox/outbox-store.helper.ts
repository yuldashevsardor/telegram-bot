import type { TelegramLimits } from "app/bootstrap/config/config-values";
import type { Database } from "app/platform/database/database";
import { MS_PER_SECOND } from "app/shared/time";
import type { OutboxCleanupSettings } from "app/telegram/outbox/store/outbox-store.types";

// Older than any message of a spec gets.
const HOUR_RETENTION_MS = 60 * 60 * MS_PER_SECOND;

// The limits of the specs that are not about the limits: a cooldown of a nanosecond, below the
// microsecond of a timestamp, and a common limit no pull reaches.
export const NO_LIMIT: TelegramLimits["common"] = { number: 1_000_000, interval: 1 };
export const NO_LIMITS: TelegramLimits = { common: NO_LIMIT, private: NO_LIMIT, group: NO_LIMIT };

// The cleanup of the specs that are not about the cleanup: it removes no message of theirs.
export const NO_CLEANUP: OutboxCleanupSettings = {
    doneRetentionMs: HOUR_RETENTION_MS,
    skippedRetentionMs: HOUR_RETENTION_MS,
    batchSize: 10,
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
