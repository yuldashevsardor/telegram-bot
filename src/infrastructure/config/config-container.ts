import path from "path";
import { Level, Levels } from "app/domain/logger/logger.types";
import { isLevel } from "app/domain/logger/logger.helper";
import { InvalidConfigError } from "app/common/errors";
import { Limit } from "app/domain/task-queue/rate-limit.types";
import { RunnerSettings } from "app/domain/task-queue/runner.types";
import { DatabaseSettings } from "app/infrastructure/database/database.types";
import { ConfigStorage } from "app/infrastructure/config/config-storage";
import { BotSettings } from "app/infrastructure/bot/bot.types";

type LoggerConfig = {
    level: Level;
};

const Environments = ["production", "development", "testing"] as const;

function isEnvironment(value: string): value is (typeof Environments)[number] {
    return Environments.some((environment) => environment === value);
}

export type Environment = (typeof Environments)[number];

// Лимиты бота по областям: общий на весь исходящий трафик и по одному на приватный чат и на
// группу. Какой из них достанется партиции, решает TelegramLimitResolver, а не сама очередь.
export type TelegramLimits = {
    common: Limit;
    private: Limit;
    group: Limit;
};

export class ConfigContainer {
    public readonly environment: Environment;
    public readonly isProduction: boolean;

    public readonly rootDir: string;
    public readonly tempDir: string;
    public readonly fontForgePath: string;

    public readonly limits: TelegramLimits;

    public readonly runner: RunnerSettings;

    public readonly bot: BotSettings;

    public readonly taskQueue: {
        gracefulShutdown: {
            timeout: number;
            interval: number;
        };
    };

    public readonly gracefulShutdown: {
        timeout: number;
    };

    public readonly logger: LoggerConfig;

    public readonly database: DatabaseSettings;

    public constructor(private readonly storage: ConfigStorage) {
        this.environment = this.getEnvironment();
        this.isProduction = this.environment === "production";

        this.rootDir = process.cwd();
        this.tempDir = this.getString("TEMP_DIR", path.join(this.rootDir, "tmp"));
        this.fontForgePath = this.getString("FONT_FORGE_PATH", "fontforge");

        this.limits = {
            common: {
                number: this.getInteger("LIMIT_COMMON_NUMBER", 30),
                interval: this.getInteger("LIMIT_COMMON_INTERVAL", 1000), // 1 секунда
            },
            private: {
                number: this.getInteger("LIMIT_PRIVATE_NUMBER", 3),
                interval: this.getInteger("LIMIT_PRIVATE_INTERVAL", 1000), // 1 секунда
            },
            group: {
                number: this.getInteger("LIMIT_GROUP_NUMBER", 20),
                interval: this.getInteger("LIMIT_GROUP_INTERVAL", 60 * 1000), // 1 минута
            },
        };

        this.runner = {
            sleepInterval: this.getInteger("RUNNER_SLEEP_INTERVAL", 1000),
            maxRetries: this.getInteger("RUNNER_MAX_RETRIES", 3),
        };

        this.bot = {
            token: this.getString("BOT_TOKEN"),
            gracefulShutdown: {
                timeout: this.getInteger("BOT_GRACEFUL_SHUTDOWN_TIMEOUT", 3000),
            },
        };

        this.taskQueue = {
            gracefulShutdown: {
                timeout: this.getInteger("TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT", 5000),
                interval: this.getInteger("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL", 500),
            },
        };

        this.gracefulShutdown = {
            timeout: this.getInteger("GRACEFUL_SHUTDOWN_TIMEOUT", 15000),
        };

        this.checkGracefulShutdown();

        this.logger = this.getLogger();
        this.database = this.getDatabase();
    }

    private getString(name: string, defaultValue = ""): string {
        const value = this.storage.get(name)?.trim();

        if (value === undefined || value === "") {
            return defaultValue;
        }

        return value;
    }

    private getInteger(name: string, defaultValue: number): number {
        const value = this.getString(name, "");

        if (value === "") {
            return defaultValue;
        }

        const parsed = Number(value);

        // Number, а не parseInt: тот молча съедает хвост ("10s" → 10) и на "abc" отдаёт NaN,
        // так что нечисловое значение уехало бы в конфиг незамеченным.
        if (!Number.isInteger(parsed)) {
            throw new InvalidConfigError(`Config value "${name}" must be an integer`, {
                got: value,
            });
        }

        return parsed;
    }

    // Сроки бота и очереди расходуются последовательно внутри общего, поэтому общий должен
    // покрывать их сумму. Дальше этого проверка не идёт: приложение не пересчитывает
    // собственные сроки всех своих зависимостей (у sql.end() внутри Database.close(), скажем,
    // свои 5 секунд) — общий срок просто берётся с запасом, а не выводится из них.
    private checkGracefulShutdown(): void {
        const { interval } = this.taskQueue.gracefulShutdown;

        if (interval <= 0) {
            throw new InvalidConfigError("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL must be greater than zero", {
                got: interval,
            });
        }

        const parts = this.bot.gracefulShutdown.timeout + this.taskQueue.gracefulShutdown.timeout;

        if (this.gracefulShutdown.timeout <= parts) {
            throw new InvalidConfigError("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and task queue timeouts", {
                application: this.gracefulShutdown.timeout,
                bot: this.bot.gracefulShutdown.timeout,
                taskQueue: this.taskQueue.gracefulShutdown.timeout,
            });
        }
    }

    private getEnvironment(): Environment {
        const value = this.getString("NODE_ENV", "development");

        if (!isEnvironment(value)) {
            throw new InvalidConfigError("Invalid environment", {
                got: value,
                allowed: Environments,
            });
        }

        return value;
    }

    private getLogger(): LoggerConfig {
        const level = this.getString("LOGGER_LEVEL", "").toUpperCase() || (this.isProduction ? Level.WARNING : Level.DEBUG);

        if (!isLevel(level)) {
            throw new InvalidConfigError("Invalid logger level", {
                got: level,
                allowed: Levels,
            });
        }

        return {
            level: level,
        };
    }

    private getDatabase(): DatabaseSettings {
        return {
            host: this.getString("DATABASE_HOST", "localhost"),
            port: this.getInteger("DATABASE_PORT", 5432),
            database: this.getString("DATABASE_NAME", "postgres"),
            username: this.getString("DATABASE_USER_NAME", "docker"),
            password: this.getString("DATABASE_USER_PASSWORD", ""),
            connection: {
                max: this.getInteger("DATABASE_CONNECTION_LIMIT", 10),
                idleTimeout: this.getInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10),
                maxLifetime: this.getInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10),
            },
        };
    }
}
