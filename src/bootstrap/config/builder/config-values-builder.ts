import path from "path";
import { Level, Levels } from "app/platform/logger/logger.types";
import { InvalidConfigError } from "app/shared/errors";
import { ConfigParser } from "app/bootstrap/config/parser/config-parser";
import type { IntegerRange } from "app/bootstrap/config/parser/config-parser";
import type { OutboxRetryDelaySettings } from "app/telegram/outbox/retry-delay/outbox-retry-delay.types";
import type { DatabaseSettings } from "app/platform/database/database.types";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import { Environments } from "app/bootstrap/config/config-values";
import type { ConfigValues, LoggerConfig } from "app/bootstrap/config/config-values";
import { MS_PER_DAY } from "app/shared/time";

// Checks that tie several variables together live here; parsing a single variable lives in ConfigParser.
export class ConfigValuesBuilder implements ConfigBuilder<ConfigValues> {
    // The outbox spaces the messages by interval / number: a zero in number makes the cooldown
    // infinite, while a zero in interval makes it nil and the limit stops limiting.
    private static readonly LIMIT_RANGE: IntegerRange = { min: 1 };

    // The numbers of the outbox cleanup SQL. It adds a retention to finished_at: up to this many ms
    // the sum stays within the timestamps PostgreSQL takes, while 1e16 ms is past the range of its
    // interval. A batch size goes to LIMIT, and 1e21 would reach it as 1e+21, which is no bigint.
    private static readonly CLEANUP_RANGE: IntegerRange = { min: 1, max: Number.MAX_SAFE_INTEGER };

    // Telegram redelivers an update within 24 h, and a done update that is still stored is what turns
    // the redelivery away, so its retention may not fall below a day.
    private static readonly INBOX_DONE_RETENTION_RANGE: IntegerRange = { min: MS_PER_DAY, max: Number.MAX_SAFE_INTEGER };

    // The connections the outbox takes besides its slots: the pull of the runner and the four
    // tasks of OutboxMaintenance, each one query at a time.
    private static readonly OUTBOX_CONNECTIONS_BESIDES_SLOTS = 5;

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

            outbox: {
                retryDelay: ConfigValuesBuilder.getOutboxRetryDelay(parser),
                resultWaiter: {
                    timeoutMs: parser.getTimerDelay("OUTBOX_RESULT_TIMEOUT", 60 * 1000),
                    pollIntervalMs: parser.getTimerDelay("OUTBOX_RESULT_POLL_INTERVAL", 1000),
                },
                leaseDurationMs: parser.getTimerDelay("OUTBOX_LEASE_DURATION", 90 * 1000),
                apiTimeoutMs: parser.getTimerDelay("OUTBOX_API_TIMEOUT", 60 * 1000),
                maxAttempts: parser.getInteger("OUTBOX_MAX_ATTEMPTS", 10, { min: 1 }),
                concurrency: parser.getInteger("OUTBOX_CONCURRENCY", 5, { min: 1 }),
                stopTimeoutMs: parser.getTimerDelay("OUTBOX_STOP_TIMEOUT", 5000, { min: 0 }),
                maintenance: {
                    leaseRecoveryIntervalMs: parser.getTimerDelay("OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL", 10 * 1000),
                    cleanupIntervalMs: parser.getTimerDelay("OUTBOX_MAINTENANCE_CLEANUP_INTERVAL", 10 * 60 * 1000),
                    statusLogIntervalMs: parser.getTimerDelay("OUTBOX_MAINTENANCE_STATUS_LOG_INTERVAL", 10 * 1000),
                },
                cleanup: {
                    doneRetentionMs: parser.getInteger("OUTBOX_DONE_RETENTION", 7 * MS_PER_DAY, ConfigValuesBuilder.CLEANUP_RANGE),
                    skippedRetentionMs: parser.getInteger("OUTBOX_SKIPPED_RETENTION", 30 * MS_PER_DAY, ConfigValuesBuilder.CLEANUP_RANGE),
                    batchSize: parser.getInteger("OUTBOX_CLEANUP_BATCH_SIZE", 1000, ConfigValuesBuilder.CLEANUP_RANGE),
                },
            },

            inbox: {
                leaseDurationMs: parser.getTimerDelay("INBOX_LEASE_DURATION", 10 * 60 * 1000),
                maxAttempts: parser.getInteger("INBOX_MAX_ATTEMPTS", 10, { min: 1 }),
                concurrency: parser.getInteger("INBOX_CONCURRENCY", 5, { min: 1 }),
                stopTimeoutMs: parser.getTimerDelay("INBOX_STOP_TIMEOUT", 5000, { min: 0 }),
                maintenance: {
                    leaseRecoveryIntervalMs: parser.getTimerDelay("INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL", 10 * 1000),
                    cleanupIntervalMs: parser.getTimerDelay("INBOX_MAINTENANCE_CLEANUP_INTERVAL", 10 * 60 * 1000),
                },
                cleanup: {
                    doneRetentionMs: parser.getInteger(
                        "INBOX_DONE_RETENTION",
                        7 * MS_PER_DAY,
                        ConfigValuesBuilder.INBOX_DONE_RETENTION_RANGE,
                    ),
                    skippedRetentionMs: parser.getInteger("INBOX_SKIPPED_RETENTION", 30 * MS_PER_DAY, ConfigValuesBuilder.CLEANUP_RANGE),
                    batchSize: parser.getInteger("INBOX_CLEANUP_BATCH_SIZE", 1000, ConfigValuesBuilder.CLEANUP_RANGE),
                },
            },

            bot: {
                token: parser.getString("BOT_TOKEN"),
                gracefulShutdown: {
                    timeout: parser.getTimerDelay("BOT_GRACEFUL_SHUTDOWN_TIMEOUT", 3000, { min: 0 }),
                },
            },

            gracefulShutdown: {
                timeout: parser.getTimerDelay("GRACEFUL_SHUTDOWN_TIMEOUT", 15000),
            },

            logger: ConfigValuesBuilder.getLogger(parser, isProduction),
            database: ConfigValuesBuilder.getDatabase(parser),
        };

        ConfigValuesBuilder.checkGracefulShutdown(values);
        ConfigValuesBuilder.checkOutboxLease(values);
        ConfigValuesBuilder.checkOutboxConcurrency(values);

        return values;
    }

    // A cap below the first step would make every step the cap, and the growth would never show.
    private static getOutboxRetryDelay(parser: ConfigParser): OutboxRetryDelaySettings {
        const firstDelayMs = parser.getTimerDelay("OUTBOX_RETRY_FIRST_DELAY", 1000);
        const maxDelayMs = parser.getTimerDelay("OUTBOX_RETRY_MAX_DELAY", 60 * 1000);
        const multiplier = parser.getInteger("OUTBOX_RETRY_DELAY_MULTIPLIER", 2, { min: 1 });

        if (maxDelayMs < firstDelayMs) {
            throw new InvalidConfigError("OUTBOX_RETRY_MAX_DELAY must not be less than OUTBOX_RETRY_FIRST_DELAY", {
                firstDelayMs: firstDelayMs,
                maxDelayMs: maxDelayMs,
            });
        }

        return { firstDelayMs: firstDelayMs, maxDelayMs: maxDelayMs, multiplier: multiplier };
    }

    // The bot and outbox deadlines are spent one after another inside the overall one, in this order,
    // so it has to cover their sum. The check goes no further: the own deadlines of the
    // dependencies are not summed up (sql.end() inside Database.close() has 5 seconds of its own),
    // and the overall deadline is taken with a margin instead.
    private static checkGracefulShutdown({ bot, outbox, gracefulShutdown }: ConfigValues): void {
        const stepTimeoutsSumMs = bot.gracefulShutdown.timeout + outbox.stopTimeoutMs;

        if (gracefulShutdown.timeout <= stepTimeoutsSumMs) {
            throw new InvalidConfigError("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and outbox timeouts", {
                application: gracefulShutdown.timeout,
                bot: bot.gracefulShutdown.timeout,
                outbox: outbox.stopTimeoutMs,
            });
        }
    }

    // A lease that ends while its call still runs hands the message to another node, and it goes out
    // twice (docs/architecture/invariants.md, "The outbox"). One call is enough to check: the worker
    // loop pulls one message per free slot and starts it at once.
    private static checkOutboxLease({ outbox }: ConfigValues): void {
        if (outbox.leaseDurationMs <= outbox.apiTimeoutMs) {
            throw new InvalidConfigError("OUTBOX_LEASE_DURATION must be greater than OUTBOX_API_TIMEOUT", {
                leaseDurationMs: outbox.leaseDurationMs,
                apiTimeoutMs: outbox.apiTimeoutMs,
            });
        }
    }

    // Each slot of the runner completes its message on a connection of the pool, and the pull
    // and the maintenance take more. A pool they fill leaves the rest of the bot, the sessions and
    // the users, waiting for a connection behind the sends.
    private static checkOutboxConcurrency({ outbox, database }: ConfigValues): void {
        if (outbox.concurrency + ConfigValuesBuilder.OUTBOX_CONNECTIONS_BESIDES_SLOTS >= database.connection.max) {
            throw new InvalidConfigError(
                "OUTBOX_CONCURRENCY plus the connections of the pull and the maintenance must be below DATABASE_CONNECTION_LIMIT",
                {
                    concurrency: outbox.concurrency,
                    connectionLimit: database.connection.max,
                },
            );
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
                max: parser.getInteger("DATABASE_CONNECTION_LIMIT", 15, { min: 1 }),
                idleTimeout: parser.getInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10, ConfigValuesBuilder.DATABASE_TIMER_RANGE),
                maxLifetime: parser.getInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10, ConfigValuesBuilder.DATABASE_TIMER_RANGE),
            },
        };
    }
}
