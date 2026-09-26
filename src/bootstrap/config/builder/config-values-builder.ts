import path from "path";
import { Level, Levels } from "app/platform/logger/logger.types";
import { InvalidConfigError } from "app/shared/errors";
import { ConfigParser } from "app/bootstrap/config/parser/config-parser";
import type { IntegerRange } from "app/bootstrap/config/parser/config-parser";
import type { RunnerSettings } from "app/telegram/outbound-queue/runner/runner.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import { Environments } from "app/bootstrap/config/config-values";
import type { ConfigValues, LoggerConfig } from "app/bootstrap/config/config-values";

// Checks that tie several variables together live here; parsing a single variable lives in ConfigParser.
export class ConfigValuesBuilder implements ConfigBuilder<ConfigValues> {
    // The cooldown of a RateLimit slot is interval / number: a zero in number makes it infinite and
    // the slot is never freed, while a zero in interval makes it nil and the limit stops limiting.
    private static readonly LIMIT_RANGE: IntegerRange = { min: 1 };

    // The pool deadlines are in seconds: postgres.js multiplies them by 1000 for setTimeout, so the
    // ceiling is the longest timer delay in seconds. A zero switches the timer off there, while a
    // negative value is truthy and would close the connection after 1 ms.
    private static readonly DATABASE_TIMER_RANGE: IntegerRange = {
        min: 0,
        max: Math.floor(ConfigParser.MAX_TIMER_DELAY / 1000),
    };

    public build(raw: RawConfig): ConfigValues {
        const parser = new ConfigParser(raw);

        const environment = parser.getEnum("NODE_ENV", Environments, "development");
        const isProduction = environment === "production";
        const rootDir = process.cwd();

        const values: ConfigValues = {
            environment: environment,
            isProduction: isProduction,

            rootDir: rootDir,
            tempDir: parser.getString("TEMP_DIR", path.join(rootDir, "tmp")),
            fontForgePath: parser.getString("FONT_FORGE_PATH", "fontforge"),

            limits: {
                common: {
                    number: parser.getInteger("LIMIT_COMMON_NUMBER", 30, ConfigValuesBuilder.LIMIT_RANGE),
                    interval: parser.getInteger("LIMIT_COMMON_INTERVAL", 1000, ConfigValuesBuilder.LIMIT_RANGE),
                },
                private: {
                    number: parser.getInteger("LIMIT_PRIVATE_NUMBER", 3, ConfigValuesBuilder.LIMIT_RANGE),
                    interval: parser.getInteger("LIMIT_PRIVATE_INTERVAL", 1000, ConfigValuesBuilder.LIMIT_RANGE),
                },
                group: {
                    number: parser.getInteger("LIMIT_GROUP_NUMBER", 20, ConfigValuesBuilder.LIMIT_RANGE),
                    interval: parser.getInteger("LIMIT_GROUP_INTERVAL", 60 * 1000, ConfigValuesBuilder.LIMIT_RANGE),
                },
            },

            runner: ConfigValuesBuilder.getRunner(parser),

            bot: {
                token: parser.getString("BOT_TOKEN"),
                gracefulShutdown: {
                    timeout: parser.getTimerDelay("BOT_GRACEFUL_SHUTDOWN_TIMEOUT", 3000, { min: 0 }),
                },
            },

            taskQueue: {
                logInterval: parser.getTimerDelay("TASK_QUEUE_LOG_INTERVAL", 10 * 1000),
                gracefulShutdown: {
                    timeout: parser.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT", 5000, { min: 0 }),
                    interval: parser.getTimerDelay("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL", 500),
                },
            },

            gracefulShutdown: {
                timeout: parser.getTimerDelay("GRACEFUL_SHUTDOWN_TIMEOUT", 15000),
            },

            logger: ConfigValuesBuilder.getLogger(parser, isProduction),
            database: ConfigValuesBuilder.getDatabase(parser),
        };

        ConfigValuesBuilder.checkGracefulShutdown(values);

        return values;
    }

    // The Runner picks a pause at random from these bounds on every empty iteration, so an empty
    // range breaks the choice silently.
    private static getRunner(parser: ConfigParser): RunnerSettings {
        const min = parser.getTimerDelay("RUNNER_SLEEP_INTERVAL_MIN", 10);
        const max = parser.getTimerDelay("RUNNER_SLEEP_INTERVAL_MAX", 1000);
        const maxRetries = parser.getInteger("RUNNER_MAX_RETRIES", 3, { min: 0 });

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

    // The bot and queue deadlines are spent one after another inside the overall one, so it has to
    // cover their sum. The check goes no further: the own deadlines of the dependencies are not
    // summed up (sql.end() inside Database.close() has 5 seconds of its own), and the overall
    // deadline is taken with a margin instead.
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

    private static getLogger(parser: ConfigParser, isProduction: boolean): LoggerConfig {
        const defaultLevel = isProduction ? Level.WARNING : Level.DEBUG;

        return {
            level: parser.getEnum("LOGGER_LEVEL", Levels, defaultLevel, { ignoreCase: true }),
        };
    }

    private static getDatabase(parser: ConfigParser): DatabaseSettings {
        return {
            host: parser.getString("DATABASE_HOST", "localhost"),
            port: parser.getPort("DATABASE_PORT", 5432),
            database: parser.getString("DATABASE_NAME", "postgres"),
            username: parser.getString("DATABASE_USER_NAME", "docker"),
            password: parser.getString("DATABASE_USER_PASSWORD", ""),
            connection: {
                max: parser.getInteger("DATABASE_CONNECTION_LIMIT", 10, { min: 1 }),
                idleTimeout: parser.getInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10, ConfigValuesBuilder.DATABASE_TIMER_RANGE),
                maxLifetime: parser.getInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10, ConfigValuesBuilder.DATABASE_TIMER_RANGE),
            },
        };
    }
}
