import type { Level } from "app/platform/logger/logger.types";
import type { Limit } from "app/telegram/outbound-queue/rate-limit/rate-limit.types";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner/runner.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { BotSettings } from "app/telegram/bot.types";

export const Environments = ["production", "development", "testing"] as const;

export type Environment = (typeof Environments)[number];

export type LoggerConfig = {
    level: Level;
};

// Лимиты бота по областям: общий на весь исходящий трафик и по одному на приватный чат и на
// группу. Какой из них достанется партиции, решает TelegramLimitResolver, а не сама очередь.
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
