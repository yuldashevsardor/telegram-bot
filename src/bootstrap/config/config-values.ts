import type { Level } from "app/platform/logger/logger.types";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner/runner.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { BotSettings } from "app/telegram/bot/bot.types";
import type { OutboxRetryDelaySettings } from "app/telegram/outbox/retry-delay/outbox-retry-delay.types";
import type { OutboxMaintenanceSettings } from "app/telegram/outbox/maintenance/outbox-maintenance.types";
import type { OutboxResultWaiterSettings } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import type { OutboxCleanupSettings } from "app/telegram/outbox/store/outbox-store.types";

export const Environments = ["production", "development", "testing"] as const;

export type Environment = (typeof Environments)[number];

export type LoggerConfig = {
    level: Level;
};

// The bot limits by scope: a common one over all outgoing traffic and one each for a private
// chat and a group. Which one a partition of the in-memory queue gets is decided by
// TelegramLimitResolver, not by the queue itself; the outbox pull picks it in its SQL
// (docs/architecture/outbox.md, "Limits").
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

    runner: RunnerSettings;

    outbox: {
        retryDelay: OutboxRetryDelaySettings;
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
    };

    bot: BotSettings;

    taskQueue: {
        logInterval: number;
        gracefulShutdown: {
            timeout: number;
            interval: number;
        };
    };

    gracefulShutdown: {
        timeout: number;
    };

    logger: LoggerConfig;

    database: DatabaseSettings;
};
