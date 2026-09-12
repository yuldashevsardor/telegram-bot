import "reflect-metadata";
import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config-container";
import { ConfigStorage } from "app/platform/config/config-storage";
import { InvalidConfigError } from "app/shared/errors";
import { Level } from "app/shared/logger.types";

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

describe("ConfigContainer", () => {
    it("falls back to defaults on an empty storage", () => {
        const result = config();

        expect(result.environment).to.equal("development");
        expect(result.isProduction).to.equal(false);
        expect(result.gracefulShutdown.timeout).to.equal(15000);
        expect(result.bot.gracefulShutdown.timeout).to.equal(3000);
        expect(result.taskQueue.gracefulShutdown.timeout).to.equal(5000);
        expect(result.taskQueue.gracefulShutdown.interval).to.equal(500);
        expect(result.runner.sleepInterval).to.deep.equal({ min: 10, max: 1000 });
        expect(result.database.host).to.equal("localhost");
        expect(result.database.port).to.equal(5432);
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
        expect(() => config({ LOGGER_LEVEL: "verbose" })).to.throw(InvalidConfigError);
    });

    it("rejects an unknown environment", () => {
        expect(() => config({ NODE_ENV: "prod" })).to.throw(InvalidConfigError);
    });

    it("rejects a value that is not an integer", () => {
        expect(() => config({ GRACEFUL_SHUTDOWN_TIMEOUT: "10s" })).to.throw(InvalidConfigError);
        expect(() => config({ DATABASE_PORT: "abc" })).to.throw(InvalidConfigError);
    });

    it("rejects a non-positive task queue poll interval", () => {
        expect(() => config({ TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "0" })).to.throw(InvalidConfigError);
        expect(() => config({ TASK_QUEUE_GRACEFUL_SHUTDOWN_INTERVAL: "-100" })).to.throw(InvalidConfigError);
    });

    it("rejects a non-positive runner sleep interval minimum", () => {
        expect(() => config({ RUNNER_SLEEP_INTERVAL_MIN: "0" })).to.throw(InvalidConfigError);
        expect(() => config({ RUNNER_SLEEP_INTERVAL_MIN: "-10" })).to.throw(InvalidConfigError);
    });

    it("rejects a runner sleep interval maximum below the minimum", () => {
        expect(() => config({ RUNNER_SLEEP_INTERVAL_MIN: "50", RUNNER_SLEEP_INTERVAL_MAX: "49" })).to.throw(InvalidConfigError);
    });

    it("accepts a runner sleep interval collapsed to a single value", () => {
        const result = config({ RUNNER_SLEEP_INTERVAL_MIN: "25", RUNNER_SLEEP_INTERVAL_MAX: "25" });

        expect(result.runner.sleepInterval).to.deep.equal({ min: 25, max: 25 });
    });

    it("rejects a shutdown timeout that does not cover the bot and the task queue", () => {
        expect(() =>
            config({
                GRACEFUL_SHUTDOWN_TIMEOUT: "8000",
                BOT_GRACEFUL_SHUTDOWN_TIMEOUT: "3000",
                TASK_QUEUE_GRACEFUL_SHUTDOWN_TIMEOUT: "5000",
            }),
        ).to.throw(InvalidConfigError);
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
