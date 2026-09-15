import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config-container";
import type { ConfigStorage } from "app/platform/config/config-storage";
import { InvalidConfigError } from "app/shared/errors";
import { Level, Levels } from "app/platform/logger/logger.types";

class FakeStorage implements ConfigStorage {
    private readonly values: Map<string, string>;

    public constructor(values: Record<string, string> = {}) {
        this.values = new Map(Object.entries(values));
    }

    public get(key: string): string | undefined {
        return this.values.get(key);
    }
}

function config(values: Record<string, string> = {}): ConfigContainer {
    return new ConfigContainer(new FakeStorage(values));
}

// Ошибку конфигурации печатает fail() в app.ts, и её текст с деталями — всё, что оператор узнает о
// неверной переменной, поэтому сверяются оба.
function rejection(values: Record<string, string>): InvalidConfigError {
    try {
        config(values);
    } catch (error) {
        expect(error).to.be.instanceOf(InvalidConfigError);

        return error as InvalidConfigError;
    }

    return expect.fail("the config was expected to be rejected");
}

describe("ConfigContainer", () => {
    it("falls back to defaults on an empty storage", () => {
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
        expect(result.runner).to.deep.equal({ sleepInterval: { min: 10, max: 1000 }, maxRetries: 3 });
        // Пустой токен отвергает конструктор Bot, а не сборка конфига.
        expect(result.bot).to.deep.equal({ token: "", gracefulShutdown: { timeout: 3000 } });
        expect(result.taskQueue).to.deep.equal({ logInterval: 10000, gracefulShutdown: { timeout: 5000, interval: 500 } });
        expect(result.gracefulShutdown).to.deep.equal({ timeout: 15000 });
        expect(result.logger).to.deep.equal({ level: Level.DEBUG });
        expect(result.database).to.deep.equal({
            host: "localhost",
            port: 5432,
            database: "postgres",
            username: "docker",
            password: "",
            connection: { max: 10, idleTimeout: 10, maxLifetime: 600 },
        });
    });

    // Значения попарно разные: переменная, прочитанная не под своим именем, отдала бы чужое.
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
            RUNNER_SLEEP_INTERVAL_MIN: "11",
            RUNNER_SLEEP_INTERVAL_MAX: "1003",
            RUNNER_MAX_RETRIES: "5",
            BOT_TOKEN: "token",
            BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3001",
            TASK_QUEUE_LOG_INTERVAL: "10001",
            TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "5001",
            TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "501",
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
        expect(result.runner).to.deep.equal({ sleepInterval: { min: 11, max: 1003 }, maxRetries: 5 });
        expect(result.bot).to.deep.equal({ token: "token", gracefulShutdown: { timeout: 3001 } });
        expect(result.taskQueue).to.deep.equal({ logInterval: 10001, gracefulShutdown: { timeout: 5001, interval: 501 } });
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
        const result = config({ DATABASE_HOST: "   ", RUNNER_MAX_RETRIES: "" });

        expect(result.database.host).to.equal("localhost");
        expect(result.runner.maxRetries).to.equal(3);
    });

    it("trims a value before using it", () => {
        expect(config({ BOT_TOKEN: "  token  " }).bot.token).to.equal("token");
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

        expect(error.message).to.equal("Invalid logger level");
        expect(error.payload).to.deep.equal({ got: "VERBOSE", allowed: Levels });
    });

    it("rejects an unknown environment", () => {
        const error = rejection({ NODE_ENV: "prod" });

        expect(error.message).to.equal("Invalid environment");
        expect(error.payload).to.deep.equal({ got: "prod", allowed: ["production", "development", "testing"] });
    });

    it("rejects a value that is not an integer", () => {
        const error = rejection({ GRACEFUL_SHUTDOWN_TIMEOUT: "10s" });

        expect(error.message).to.equal('Config value "GRACEFUL_SHUTDOWN_TIMEOUT" must be an integer');
        expect(error.payload).to.deep.equal({ got: "10s" });
        expect(() => config({ DATABASE_PORT: "abc" })).to.throw(InvalidConfigError);
    });

    it("rejects a non-positive task queue poll interval", () => {
        const error = rejection({ TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "0" });

        expect(error.message).to.equal("TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL must be greater than zero");
        expect(error.payload).to.deep.equal({ got: 0 });
        expect(() => config({ TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "-100" })).to.throw(InvalidConfigError);
    });

    it("rejects a task queue log interval that a timer would turn into 1 ms", () => {
        const error = rejection({ TASK_QUEUE_LOG_INTERVAL: "0" });

        expect(error.message).to.equal("TASK_QUEUE_LOG_INTERVAL must be between 1 and 2147483647");
        expect(error.payload).to.deep.equal({ got: 0 });
        expect(() => config({ TASK_QUEUE_LOG_INTERVAL: "-100" })).to.throw(InvalidConfigError);
        expect(() => config({ TASK_QUEUE_LOG_INTERVAL: "2147483648" })).to.throw(InvalidConfigError);
    });

    it("accepts the longest task queue log interval a timer can hold", () => {
        expect(config({ TASK_QUEUE_LOG_INTERVAL: "2147483647" }).taskQueue.logInterval).to.equal(2147483647);
    });

    it("rejects a non-positive runner sleep interval minimum", () => {
        const error = rejection({ RUNNER_SLEEP_INTERVAL_MIN: "0" });

        expect(error.message).to.equal("RUNNER_SLEEP_INTERVAL_MIN must be greater than zero");
        expect(error.payload).to.deep.equal({ got: 0 });
        expect(() => config({ RUNNER_SLEEP_INTERVAL_MIN: "-10" })).to.throw(InvalidConfigError);
    });

    it("rejects a runner sleep interval maximum below the minimum", () => {
        const error = rejection({ RUNNER_SLEEP_INTERVAL_MIN: "50", RUNNER_SLEEP_INTERVAL_MAX: "49" });

        expect(error.message).to.equal("RUNNER_SLEEP_INTERVAL_MAX must not be less than RUNNER_SLEEP_INTERVAL_MIN");
        expect(error.payload).to.deep.equal({ min: 50, max: 49 });
    });

    it("accepts a runner sleep interval collapsed to a single value", () => {
        const result = config({ RUNNER_SLEEP_INTERVAL_MIN: "25", RUNNER_SLEEP_INTERVAL_MAX: "25" });

        expect(result.runner.sleepInterval).to.deep.equal({ min: 25, max: 25 });
    });

    it("rejects a shutdown timeout that does not cover the bot and the task queue", () => {
        const error = rejection({
            GRACEFUL_SHUTDOWN_TIMEOUT: "8000",
            BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3000",
            TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "5000",
        });

        expect(error.message).to.equal("GRACEFUL_SHUTDOWN_TIMEOUT must be greater than the sum of the bot and task queue timeouts");
        expect(error.payload).to.deep.equal({ application: 8000, bot: 3000, taskQueue: 5000 });
    });

    it("accepts a shutdown timeout that covers the bot and the task queue", () => {
        const result = config({
            GRACEFUL_SHUTDOWN_TIMEOUT: "8001",
            BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3000",
            TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "5000",
        });

        expect(result.gracefulShutdown.timeout).to.equal(8001);
    });
});
