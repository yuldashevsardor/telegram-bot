import "reflect-metadata";
import { expect } from "chai";
import { ConfigContainer } from "app/infrastructure/config/config-container";
import { ConfigStorage } from "app/infrastructure/config/config-storage";
import { InvalidConfigError } from "app/common/errors";
import { Level } from "app/domain/logger/logger.types";

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
        expect(result.bot.shutdownTimeout).to.equal(5000);
        expect(result.broker.sleepInterval).to.equal(1000);
        expect(result.database.host).to.equal("localhost");
        expect(result.database.port).to.equal(5432);
    });

    it("treats a blank value as a missing one", () => {
        const result = config({ DATABASE_HOST: "   ", BROKER_MAX_RETRIES: "" });

        expect(result.database.host).to.equal("localhost");
        expect(result.broker.maxRetries).to.equal(3);
    });

    it("trims a value before using it", () => {
        expect(config({ BOT_TOKEN: "  token  " }).bot.token).to.equal("token");
    });

    it("picks the development logger defaults", () => {
        const result = config();

        expect(result.logger.default).to.equal("ConsoleLogger");
        expect(result.logger.level).to.equal(Level.DEBUG);
    });

    it("picks the production logger defaults", () => {
        const result = config({ ENVIRONMENT: "production" });

        expect(result.isProduction).to.equal(true);
        expect(result.logger.default).to.equal("PinoLogger");
        expect(result.logger.level).to.equal(Level.WARNING);
    });

    it("reads the logger level case-insensitively", () => {
        expect(config({ LOGGER_LEVEL: "info" }).logger.level).to.equal(Level.INFO);
    });

    it("rejects an unknown logger level", () => {
        expect(() => config({ LOGGER_LEVEL: "verbose" })).to.throw(InvalidConfigError);
    });

    it("rejects an unknown default logger", () => {
        expect(() => config({ LOGGER_DEFAULT: "SyslogLogger" })).to.throw(InvalidConfigError);
    });
});
