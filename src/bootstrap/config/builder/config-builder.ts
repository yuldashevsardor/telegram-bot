import path from "path";
import { Level, Levels } from "app/platform/logger/logger.types";
import { InvalidConfigError } from "app/shared/errors";
import { ConfigReader } from "app/bootstrap/config/reader/config-reader";
import type { IntegerRange } from "app/bootstrap/config/reader/config-reader";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import { Environments } from "app/bootstrap/config/config-values";
import type { ConfigValues, LoggerConfig } from "app/bootstrap/config/config-values";

// Собирает ConfigValues из источника: разбор идёт через ConfigReader, а проверки, связывающие
// несколько переменных, — здесь, поэтому отказ конфигурации приходится на build(), то есть на старт.
export class ConfigBuilder {
    // Остывание слота RateLimit — interval / number: ноль в number делает его бесконечным, и слот
    // не освобождается никогда, а ноль в interval — нулевым, и лимит перестаёт ограничивать.
    private static readonly LIMIT_RANGE: IntegerRange = { min: 1 };

    // Сроки пула в секундах: postgres.js умножает их на 1000 для setTimeout, поэтому потолок —
    // наибольшая задержка таймера в секундах. Ноль у него выключает таймер, а отрицательное
    // значение истинно и закрыло бы соединение через 1 мс.
    private static readonly DATABASE_TIMER_RANGE: IntegerRange = {
        min: 0,
        max: Math.floor(ConfigReader.MAX_TIMER_DELAY / 1000),
    };

    private readonly reader: ConfigReader;

    public constructor(storage: ConfigStorage) {
        this.reader = new ConfigReader(storage);
    }

    public build(): ConfigValues {
        const environment = this.reader.getEnum("NODE_ENV", Environments, "development");
        const isProduction = environment === "production";
        const rootDir = process.cwd();

        const values: ConfigValues = {
            environment: environment,
            isProduction: isProduction,

            rootDir: rootDir,
            tempDir: this.reader.getString("TEMP_DIR", path.join(rootDir, "tmp")),
            fontForgePath: this.reader.getString("FONT_FORGE_PATH", "fontforge"),

            limits: {
                common: {
                    number: this.reader.getInteger("LIMIT_COMMON_NUMBER", 30, ConfigBuilder.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_COMMON_INTERVAL", 1000, ConfigBuilder.LIMIT_RANGE), // 1 секунда
                },
                private: {
                    number: this.reader.getInteger("LIMIT_PRIVATE_NUMBER", 3, ConfigBuilder.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_PRIVATE_INTERVAL", 1000, ConfigBuilder.LIMIT_RANGE), // 1 секунда
                },
                group: {
                    number: this.reader.getInteger("LIMIT_GROUP_NUMBER", 20, ConfigBuilder.LIMIT_RANGE),
                    interval: this.reader.getInteger("LIMIT_GROUP_INTERVAL", 60 * 1000, ConfigBuilder.LIMIT_RANGE), // 1 минута
                },
            },

            runner: this.getRunner(),

            bot: {
                token: this.reader.getString("BOT_TOKEN"),
                gracefulShutdown: {
                    timeout: this.reader.getTimerDelay("BOT_GRACEFUL_SHUTDOWN_TIMEOUT", 3000, { min: 0 }),
                },
            },

            taskQueue: {
                logInterval: this.reader.getTimerDelay("TASK_QUEUE_LOG_INTERVAL", 10 * 1000), // 10 секунд
                gracefulShutdown: {
                    timeout: this.reader.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT", 5000, { min: 0 }),
                    interval: this.reader.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL", 500),
                },
            },

            gracefulShutdown: {
                timeout: this.reader.getTimerDelay("GRACEFUL_SHUTDOWN_TIMEOUT", 15000),
            },

            logger: this.getLogger(isProduction),
            database: this.getDatabase(),
        };

        ConfigBuilder.checkGracefulShutdown(values);

        return values;
    }

    // Из этих границ Runner случайно выбирает паузу на каждой пустой итерации, поэтому пустой
    // диапазон ломает выбор молча.
    private getRunner(): RunnerSettings {
        const min = this.reader.getTimerDelay("RUNNER_SLEEP_INTERVAL_MIN", 10);
        const max = this.reader.getTimerDelay("RUNNER_SLEEP_INTERVAL_MAX", 1000);
        const maxRetries = this.reader.getInteger("RUNNER_MAX_RETRIES", 3, { min: 0 });

        if (max < min) {
            throw new InvalidConfigError("RUNNER_SLEEP_INTERVAL_MAX must not be less than RUNNER_SLEEP_INTERVAL_MIN", {
                min: min,
                max: max,
            });
        }

        return {
            sleepInterval: { min: min, max: max },
            maxRetries: maxRetries,
        };
    }

    // Сроки бота и очереди расходуются последовательно внутри общего, поэтому общий должен
    // покрывать их сумму. Дальше этого проверка не идёт: приложение не пересчитывает
    // собственные сроки всех своих зависимостей (у sql.end() внутри Database.close(), скажем,
    // свои 5 секунд) — общий срок просто берётся с запасом, а не выводится из них.
    private static checkGracefulShutdown({ bot, taskQueue, gracefulShutdown }: ConfigValues): void {
        const parts = bot.gracefulShutdown.timeout + taskQueue.gracefulShutdown.timeout;

        if (gracefulShutdown.timeout <= parts) {
            throw new InvalidConfigError("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and task queue timeouts", {
                application: gracefulShutdown.timeout,
                bot: bot.gracefulShutdown.timeout,
                taskQueue: taskQueue.gracefulShutdown.timeout,
            });
        }
    }

    private getLogger(isProduction: boolean): LoggerConfig {
        const defaultLevel = isProduction ? Level.WARNING : Level.DEBUG;

        return {
            level: this.reader.getEnum("LOGGER_LEVEL", Levels, defaultLevel, { ignoreCase: true }),
        };
    }

    private getDatabase(): DatabaseSettings {
        return {
            host: this.reader.getString("DATABASE_HOST", "localhost"),
            port: this.reader.getPort("DATABASE_PORT", 5432),
            database: this.reader.getString("DATABASE_NAME", "postgres"),
            username: this.reader.getString("DATABASE_USER_NAME", "docker"),
            password: this.reader.getString("DATABASE_USER_PASSWORD", ""),
            connection: {
                max: this.reader.getInteger("DATABASE_CONNECTION_LIMIT", 10, { min: 1 }),
                idleTimeout: this.reader.getInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10, ConfigBuilder.DATABASE_TIMER_RANGE),
                maxLifetime: this.reader.getInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10, ConfigBuilder.DATABASE_TIMER_RANGE),
            },
        };
    }
}
