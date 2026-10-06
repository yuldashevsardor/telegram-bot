import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { InvalidConfigError } from "app/shared/errors";
import { Level, Levels } from "app/platform/logger/logger.types";

// BOT_TOKEN is required, so it is supplied to every spec; a spec that needs it missing overwrites it
// with a blank value.
function config(values: Record<string, string> = {}): ConfigValues {
    return new ConfigValuesBuilder().build({ BOT_TOKEN: "token", ...values });
}

// A config error is printed by fail() in app.ts, and its text together with its details is all the
// operator learns about the wrong variable, so both are checked.
function rejection(values: Record<string, string>): InvalidConfigError {
    try {
        config(values);
    } catch (error) {
        expect(error).to.be.instanceOf(InvalidConfigError);

        return error as InvalidConfigError;
    }

    return expect.fail("the config was expected to be rejected");
}

describe("ConfigValuesBuilder", () => {
    it("falls back to defaults when only the bot token is set", () => {
        const result = config();

        expect(result.environment).to.equal("development");
        expect(result.isProduction).to.equal(false);
        expect(result.rootDir).to.equal(process.cwd());
        expect(result.tempDir).to.equal(path.join(process.cwd(), "tmp"));
        expect(result.fontForgePath).to.equal("fontforge");
        expect(result.limits).to.deep.equal({
            common: { number: 30, interval: 1000 },
            private: { number: 3, interval: 1000 },
            group: { number: 20, interval: 60000 },
        });
        expect(result.outbox).to.deep.equal({
            retryDelay: { firstDelayMs: 1000, maxDelayMs: 60000, multiplier: 2 },
            resultWaiter: { timeoutMs: 60000, pollIntervalMs: 1000 },
            leaseDurationMs: 90000,
            apiTimeoutMs: 60000,
            maxAttempts: 10,
            concurrency: 5,
            stopTimeoutMs: 5000,
            maintenance: { leaseRecoveryIntervalMs: 10000, cleanupIntervalMs: 600000, statusLogIntervalMs: 10000 },
            cleanup: { doneRetentionMs: 604800000, skippedRetentionMs: 2592000000, batchSize: 1000 },
        });
        expect(result.inbox).to.deep.equal({
            leaseDurationMs: 600000,
            maxAttempts: 10,
            concurrency: 5,
            stopTimeoutMs: 5000,
            maintenance: { leaseRecoveryIntervalMs: 10000, cleanupIntervalMs: 600000 },
            cleanup: { doneRetentionMs: 604800000, skippedRetentionMs: 2592000000, batchSize: 1000 },
        });
        expect(result.bot).to.deep.equal({ token: "token", gracefulShutdown: { timeout: 3000 } });
        expect(result.gracefulShutdown).to.deep.equal({ timeout: 15000 });
        expect(result.logger).to.deep.equal({ level: Level.DEBUG });
        expect(result.database).to.deep.equal({
            host: "localhost",
            port: 5432,
            database: "postgres",
            username: "docker",
            password: "",
            connection: { max: 15, idleTimeout: 10, maxLifetime: 600 },
        });
    });

    // The values differ pairwise: a variable read under the wrong name would return somebody else's.
    it("reads every setting from its own variable", () => {
        const result = config({
            NODE_ENV: "production",
            TEMP_DIR: "/data/tmp",
            FONT_FORGE_PATH: "/opt/fontforge/bin/fontforge",
            LIMIT_COMMON_NUMBER: "31",
            LIMIT_COMMON_INTERVAL: "1001",
            LIMIT_PRIVATE_NUMBER: "4",
            LIMIT_PRIVATE_INTERVAL: "1002",
            LIMIT_GROUP_NUMBER: "21",
            LIMIT_GROUP_INTERVAL: "60001",
            OUTBOX_RETRY_FIRST_DELAY: "1004",
            OUTBOX_RETRY_MAX_DELAY: "60002",
            OUTBOX_RETRY_DELAY_MULTIPLIER: "3",
            OUTBOX_RESULT_TIMEOUT: "60003",
            OUTBOX_RESULT_POLL_INTERVAL: "1005",
            OUTBOX_LEASE_DURATION: "600001",
            OUTBOX_API_TIMEOUT: "60004",
            OUTBOX_MAX_ATTEMPTS: "11",
            OUTBOX_DONE_RETENTION: "604800001",
            OUTBOX_SKIPPED_RETENTION: "2592000001",
            OUTBOX_CLEANUP_BATCH_SIZE: "1001",
            OUTBOX_CONCURRENCY: "6",
            OUTBOX_STOP_TIMEOUT: "5002",
            OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL: "10002",
            OUTBOX_MAINTENANCE_CLEANUP_INTERVAL: "600003",
            OUTBOX_MAINTENANCE_STATUS_LOG_INTERVAL: "10003",
            INBOX_LEASE_DURATION: "600002",
            INBOX_MAX_ATTEMPTS: "12",
            INBOX_CONCURRENCY: "7",
            INBOX_STOP_TIMEOUT: "5003",
            INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL: "10004",
            INBOX_MAINTENANCE_CLEANUP_INTERVAL: "600004",
            INBOX_DONE_RETENTION: "604800002",
            INBOX_SKIPPED_RETENTION: "2592000002",
            INBOX_CLEANUP_BATCH_SIZE: "1002",
            BOT_TOKEN: "own-token",
            BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3001",
            GRACEFUL_SHUTDOWN_TIMEOUT: "15001",
            LOGGER_LEVEL: "INFO",
            DATABASE_HOST: "pgsql",
            DATABASE_PORT: "5433",
            DATABASE_NAME: "bot",
            DATABASE_USER_NAME: "bot_user",
            DATABASE_USER_PASSWORD: "secret",
            DATABASE_CONNECTION_LIMIT: "12",
            DATABASE_CONNECTION_IDLE_TIMEOUT: "13",
            DATABASE_CONNECTION_MAX_LIFETIME: "601",
        });

        expect(result.environment).to.equal("production");
        expect(result.isProduction).to.equal(true);
        expect(result.tempDir).to.equal("/data/tmp");
        expect(result.fontForgePath).to.equal("/opt/fontforge/bin/fontforge");
        expect(result.limits).to.deep.equal({
            common: { number: 31, interval: 1001 },
            private: { number: 4, interval: 1002 },
            group: { number: 21, interval: 60001 },
        });
        expect(result.outbox).to.deep.equal({
            retryDelay: { firstDelayMs: 1004, maxDelayMs: 60002, multiplier: 3 },
            resultWaiter: { timeoutMs: 60003, pollIntervalMs: 1005 },
            leaseDurationMs: 600001,
            apiTimeoutMs: 60004,
            maxAttempts: 11,
            concurrency: 6,
            stopTimeoutMs: 5002,
            maintenance: { leaseRecoveryIntervalMs: 10002, cleanupIntervalMs: 600003, statusLogIntervalMs: 10003 },
            cleanup: { doneRetentionMs: 604800001, skippedRetentionMs: 2592000001, batchSize: 1001 },
        });
        expect(result.inbox).to.deep.equal({
            leaseDurationMs: 600002,
            maxAttempts: 12,
            concurrency: 7,
            stopTimeoutMs: 5003,
            maintenance: { leaseRecoveryIntervalMs: 10004, cleanupIntervalMs: 600004 },
            cleanup: { doneRetentionMs: 604800002, skippedRetentionMs: 2592000002, batchSize: 1002 },
        });
        expect(result.bot).to.deep.equal({ token: "own-token", gracefulShutdown: { timeout: 3001 } });
        expect(result.gracefulShutdown).to.deep.equal({ timeout: 15001 });
        expect(result.logger).to.deep.equal({ level: Level.INFO });
        expect(result.database).to.deep.equal({
            host: "pgsql",
            port: 5433,
            database: "bot",
            username: "bot_user",
            password: "secret",
            connection: { max: 12, idleTimeout: 13, maxLifetime: 601 },
        });
    });

    it("treats a blank value as a missing one", () => {
        const result = config({ DATABASE_HOST: "   ", OUTBOX_MAX_ATTEMPTS: "" });

        expect(result.database.host).to.equal("localhost");
        expect(result.outbox.maxAttempts).to.equal(10);
    });

    it("trims a value before using it", () => {
        expect(config({ BOT_TOKEN: "  trimmed  " }).bot.token).to.equal("trimmed");
    });

    it("requires the bot token", () => {
        const error = rejection({ BOT_TOKEN: "" });

        expect(error.message).to.equal('Config value "BOT_TOKEN" is required');
        expect(() => config({ BOT_TOKEN: "   " })).to.throw(InvalidConfigError);
    });

    it("picks the development logger level", () => {
        expect(config().logger.level).to.equal(Level.DEBUG);
    });

    it("picks the production logger level", () => {
        const result = config({ NODE_ENV: "production" });

        expect(result.isProduction).to.equal(true);
        expect(result.logger.level).to.equal(Level.WARNING);
    });

    it("reads the logger level case-insensitively", () => {
        expect(config({ LOGGER_LEVEL: "info" }).logger.level).to.equal(Level.INFO);
    });

    it("rejects an unknown logger level", () => {
        const error = rejection({ LOGGER_LEVEL: "verbose" });

        expect(error.message).to.equal('Config value "LOGGER_LEVEL" must be one of the allowed values');
        expect(error.payload).to.deep.equal({ got: "verbose", allowed: Levels });
    });

    it("rejects an unknown environment", () => {
        const error = rejection({ NODE_ENV: "prod" });

        expect(error.message).to.equal('Config value "NODE_ENV" must be one of the allowed values');
        expect(error.payload).to.deep.equal({ got: "prod", allowed: ["production", "development", "testing"] });
    });

    it("rejects a value that is not an integer", () => {
        const error = rejection({ GRACEFUL_SHUTDOWN_TIMEOUT: "10s" });

        expect(error.message).to.equal('Config value "GRACEFUL_SHUTDOWN_TIMEOUT" must be an integer');
        expect(error.payload).to.deep.equal({ got: "10s" });
        expect(() => config({ DATABASE_PORT: "abc" })).to.throw(InvalidConfigError);
    });

    // The message names every bound of a variable, so a single value below the minimum is enough to
    // check its whole range. That the bounds themselves pass is checked by config-parser.spec.ts.
    const bounds: Array<{ name: string; below: string; range: string }> = [
        { name: "LIMIT_COMMON_NUMBER", below: "0", range: "at least 1" },
        { name: "LIMIT_COMMON_INTERVAL", below: "0", range: "at least 1" },
        { name: "LIMIT_PRIVATE_NUMBER", below: "0", range: "at least 1" },
        { name: "LIMIT_PRIVATE_INTERVAL", below: "0", range: "at least 1" },
        { name: "LIMIT_GROUP_NUMBER", below: "0", range: "at least 1" },
        { name: "LIMIT_GROUP_INTERVAL", below: "0", range: "at least 1" },
        { name: "OUTBOX_RETRY_FIRST_DELAY", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_RETRY_MAX_DELAY", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_RETRY_DELAY_MULTIPLIER", below: "0", range: "at least 1" },
        { name: "OUTBOX_RESULT_TIMEOUT", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_RESULT_POLL_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_LEASE_DURATION", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_API_TIMEOUT", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_MAX_ATTEMPTS", below: "0", range: "at least 1" },
        { name: "OUTBOX_DONE_RETENTION", below: "0", range: "between 1 and 9007199254740991" },
        { name: "OUTBOX_SKIPPED_RETENTION", below: "0", range: "between 1 and 9007199254740991" },
        { name: "OUTBOX_CLEANUP_BATCH_SIZE", below: "0", range: "between 1 and 9007199254740991" },
        { name: "OUTBOX_CONCURRENCY", below: "0", range: "at least 1" },
        { name: "OUTBOX_STOP_TIMEOUT", below: "-1", range: "between 0 and 2147483647" },
        { name: "OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_MAINTENANCE_CLEANUP_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "OUTBOX_MAINTENANCE_STATUS_LOG_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "INBOX_LEASE_DURATION", below: "0", range: "between 1 and 2147483647" },
        { name: "INBOX_MAX_ATTEMPTS", below: "0", range: "at least 1" },
        { name: "INBOX_CONCURRENCY", below: "0", range: "at least 1" },
        { name: "INBOX_STOP_TIMEOUT", below: "-1", range: "between 0 and 2147483647" },
        { name: "INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "INBOX_MAINTENANCE_CLEANUP_INTERVAL", below: "0", range: "between 1 and 2147483647" },
        { name: "INBOX_SKIPPED_RETENTION", below: "0", range: "between 1 and 9007199254740991" },
        { name: "INBOX_CLEANUP_BATCH_SIZE", below: "0", range: "between 1 and 9007199254740991" },
        { name: "BOT_GRACEFUL_SHUTDOWN_TIMEOUT", below: "-1", range: "between 0 and 2147483647" },
        { name: "GRACEFUL_SHUTDOWN_TIMEOUT", below: "0", range: "between 1 and 2147483647" },
        { name: "DATABASE_PORT", below: "0", range: "between 1 and 65535" },
        { name: "DATABASE_CONNECTION_LIMIT", below: "0", range: "at least 1" },
        { name: "DATABASE_CONNECTION_IDLE_TIMEOUT", below: "-1", range: "between 0 and 2147483" },
        { name: "DATABASE_CONNECTION_MAX_LIFETIME", below: "-1", range: "between 0 and 2147483" },
    ];

    for (const { name, below, range } of bounds) {
        it(`rejects ${name} below its range`, () => {
            const error = rejection({ [name]: below });

            expect(error.message).to.equal(`Config value "${name}" must be ${range}`);
            expect(error.payload).to.include({ got: Number(below) });
        });
    }

    // Telegram redelivers an update within 24 h: a shorter retention would let a redelivery in again.
    it("rejects an inbox done retention below a day and accepts a day", () => {
        const error = rejection({ INBOX_DONE_RETENTION: "86399999" });

        expect(error.message).to.equal('Config value "INBOX_DONE_RETENTION" must be between 86400000 and 9007199254740991');
        expect(config({ INBOX_DONE_RETENTION: "86400000" }).inbox.cleanup.doneRetentionMs).to.equal(86400000);
    });

    it("accepts zero where it means not to wait or to switch a timer off", () => {
        const result = config({
            BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "0",
            DATABASE_CONNECTION_IDLE_TIMEOUT: "0",
            DATABASE_CONNECTION_MAX_LIFETIME: "0",
            OUTBOX_STOP_TIMEOUT: "0",
        });

        expect(result.outbox.stopTimeoutMs).to.equal(0);
        expect(result.bot.gracefulShutdown.timeout).to.equal(0);
        expect(result.database.connection).to.deep.equal({ max: 15, idleTimeout: 0, maxLifetime: 0 });
    });

    it("rejects an outbox retry delay cap below the first step", () => {
        const error = rejection({ OUTBOX_RETRY_FIRST_DELAY: "5000", OUTBOX_RETRY_MAX_DELAY: "4999" });

        expect(error.message).to.equal("OUTBOX_RETRY_MAX_DELAY must not be less than OUTBOX_RETRY_FIRST_DELAY");
        expect(error.payload).to.deep.equal({ firstDelayMs: 5000, maxDelayMs: 4999 });
    });

    it("accepts an outbox retry delay cap equal to the first step and a multiplier of 1", () => {
        const result = config({ OUTBOX_RETRY_FIRST_DELAY: "5000", OUTBOX_RETRY_MAX_DELAY: "5000", OUTBOX_RETRY_DELAY_MULTIPLIER: "1" });

        expect(result.outbox.retryDelay).to.deep.equal({ firstDelayMs: 5000, maxDelayMs: 5000, multiplier: 1 });
    });

    it("rejects an outbox lease not above the Bot API call timeout", () => {
        const error = rejection({ OUTBOX_LEASE_DURATION: "30000", OUTBOX_API_TIMEOUT: "30000" });

        expect(error.message).to.equal("OUTBOX_LEASE_DURATION must be greater than OUTBOX_API_TIMEOUT");
        expect(error.payload).to.deep.equal({ leaseDurationMs: 30000, apiTimeoutMs: 30000 });
    });

    it("accepts an outbox lease above the Bot API call timeout", () => {
        const result = config({ OUTBOX_LEASE_DURATION: "30001", OUTBOX_API_TIMEOUT: "30000" });

        expect(result.outbox).to.include({ leaseDurationMs: 30001, apiTimeoutMs: 30000 });
    });

    // The pull and the four maintenance tasks take five connections besides the slots.
    it("rejects an outbox concurrency that leaves no connection besides the outbox", () => {
        const error = rejection({ OUTBOX_CONCURRENCY: "5", DATABASE_CONNECTION_LIMIT: "10" });

        expect(error.message).to.equal(
            "OUTBOX_CONCURRENCY plus the connections of the pull and the maintenance must be below DATABASE_CONNECTION_LIMIT",
        );
        expect(error.payload).to.deep.equal({ concurrency: 5, connectionLimit: 10 });
    });

    it("accepts an outbox concurrency that leaves one connection besides the outbox", () => {
        const result = config({ OUTBOX_CONCURRENCY: "4", DATABASE_CONNECTION_LIMIT: "10" });

        expect(result.outbox.concurrency).to.equal(4);
        expect(result.database.connection.max).to.equal(10);
    });

    it("rejects a shutdown timeout that does not cover the bot and the outbox", () => {
        const error = rejection({ GRACEFUL_SHUTDOWN_TIMEOUT: "5000", BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3000", OUTBOX_STOP_TIMEOUT: "2000" });

        expect(error.message).to.equal("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and outbox timeouts");
        expect(error.payload).to.deep.equal({ application: 5000, bot: 3000, outbox: 2000 });
    });

    it("accepts a shutdown timeout that covers the bot and the outbox", () => {
        const result = config({ GRACEFUL_SHUTDOWN_TIMEOUT: "5001", BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3000", OUTBOX_STOP_TIMEOUT: "2000" });

        expect(result.gracefulShutdown.timeout).to.equal(5001);
    });
});
