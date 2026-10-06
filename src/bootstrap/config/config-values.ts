import type { Level } from "app/platform/logger/logger.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { BotSettings } from "app/telegram/bot/bot.types";
import type { RetryDelaySettings } from "app/telegram/retry-delay/retry-delay.types";
import type { OutboxMaintenanceSettings } from "app/telegram/outbox/maintenance/outbox-maintenance.types";
import type { OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import type { InboxCleanupSettings } from "app/telegram/inbox/store/inbox-store.types";
import type { InboxMaintenanceSettings } from "app/telegram/inbox/maintenance/inbox-maintenance.types";
import type { OutboxCleanupSettings } from "app/telegram/outbox/store/outbox-store.types";

export const Environments = ["production", "development", "testing"] as const;

export type Environment = (typeof Environments)[number];

export type LoggerConfig = {
    level: Level;
};

// At most number messages per interval ms.
export type Limit = {
    number: number;
    interval: number;
};

// The bot limits by scope: a common one over all outgoing traffic and one each for a private
// chat and a group. The outbox pull picks the chat limit in its SQL (docs/architecture/outbox.md,
// "Limits").
export type TelegramLimits = {
    common: Limit;
    private: Limit;
    group: Limit;
};

export type ConfigValues = {
    environment: Environment;
    isProduction: boolean;

    rootDir: string;
    tempDir: string;
    fontForgePath: string;

    limits: TelegramLimits;

    // The retry delay of the outbox and the inbox, and the pause of the polling source of the inbox.
    retryDelay: RetryDelaySettings;

    outbox: {
        resultWaiter: OutboxResultWaiterSettings;
        // How long a pulled chat stays with the node that pulled it.
        leaseDurationMs: number;
        // How long the sender waits for one Bot API call before it fails.
        apiTimeoutMs: number;
        // The attempts of a message that count towards the limit, the last one included.
        maxAttempts: number;
        // How many messages the runner of a node sends at once.
        concurrency: number;
        // How long the stop of the runner waits for the calls in flight before it aborts them.
        stopTimeoutMs: number;
        maintenance: OutboxMaintenanceSettings;
        cleanup: OutboxCleanupSettings;
    };

    inbox: {
        // How long a claimed group stays with the node that claimed it.
        leaseDurationMs: number;
        // The attempts of an update that count towards the limit, the last one included.
        maxAttempts: number;
        // How many updates the runner of a node handles at once.
        concurrency: number;
        // How long the stop of the runner waits for the handlers in flight before it leaves them.
        stopTimeoutMs: number;
        maintenance: InboxMaintenanceSettings;
        cleanup: InboxCleanupSettings;
    };

    bot: BotSettings;

    gracefulShutdown: {
        timeout: number;
    };

    logger: LoggerConfig;

    database: DatabaseSettings;
};
