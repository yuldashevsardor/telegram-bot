import path from "path";
import { Level, Levels } from "app/domain/logger/logger.types";
import { InvalidConfigError } from "app/common/errors";
import { Limits } from "app/domain/planner/planner.types";
import { BrokerSettings } from "app/domain/broker/broker.types";
import { DatabaseSettings } from "app/infrastructure/database/database.types";
import { ConfigStorage } from "app/infrastructure/config/config-storage";

type LoggerConfig = {
    default: LoggerType;
    level: Level;
};

export type LoggerType = "ConsoleLogger" | "PinoLogger";

export type Environment = "production" | "development" | "testing";

export class ConfigContainer {
    private static readonly allowedLoggerTypes: ReadonlyArray<LoggerType> = ["ConsoleLogger", "PinoLogger"];

    public readonly environment: Environment;
    public readonly isProduction: boolean;

    public readonly rootDir: string;
    public readonly tempDir: string;
    public readonly fontForgePath: string;

    public readonly managerLimits: Limits;

    public readonly broker: BrokerSettings;

    public readonly bot: {
        token: string;
        shutdownTimeout: number;
    };

    public readonly logger: LoggerConfig;

    public readonly database: DatabaseSettings;

    public constructor(private readonly storage: ConfigStorage) {
        this.environment = this.getString("ENVIRONMENT", "development") as Environment;
        this.isProduction = this.environment === "production";

        this.rootDir = process.cwd();
        this.tempDir = this.getString("TEMP_DIR", path.join(this.rootDir, "tmp"));
        this.fontForgePath = this.getString("FONT_FORGE_PATH", "fontforge");

        this.managerLimits = {
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

        this.broker = {
            sleepInterval: this.getInteger("BROKER_SLEEP_INTERVAL", 1000),
            maxRetries: this.getInteger("BROKER_MAX_RETRIES", 3),
        };

        this.bot = {
            token: this.getString("BOT_TOKEN"),
            shutdownTimeout: this.getInteger("BOT_SHUTDOWN_TIMEOUT", 5000),
        };

        this.logger = this.getLogger();
        this.database = this.getDatabase();
    }

    private getString(name: string, defaultValue = ""): string {
        let value = this.storage.get(name);

        if (value !== undefined) {
            value = value.trim();
        }

        if (value === null || value === undefined || value === "") {
            return defaultValue;
        }

        return value;
    }

    private getInteger(name: string, defaultValue: number): number {
        const value = this.getString(name, "");

        if (value === "") {
            return defaultValue;
        }

        return parseInt(value);
    }

    private static isAllowedLoggerType(value: string): value is LoggerType {
        return ConfigContainer.allowedLoggerTypes.some((allowed) => allowed === value);
    }

    private static isLevel(value: string): value is Level {
        return Levels.some((level) => level === value);
    }

    private getLogger(): LoggerConfig {
        const defaultLoggerKey = this.getString("LOGGER_DEFAULT", "") || (this.isProduction ? "PinoLogger" : "ConsoleLogger");

        if (!ConfigContainer.isAllowedLoggerType(defaultLoggerKey)) {
            throw new InvalidConfigError({
                message: "Invalid default logger",
                payload: {
                    got: defaultLoggerKey,
                    allowed: ConfigContainer.allowedLoggerTypes,
                },
            });
        }

        const level = this.getString("LOGGER_LEVEL", "").toUpperCase() || (this.isProduction ? Level.WARNING : Level.DEBUG);

        if (!ConfigContainer.isLevel(level)) {
            throw new InvalidConfigError({
                message: "Invalid logger level",
                payload: {
                    got: level,
                    allowed: Levels,
                },
            });
        }

        return {
            default: defaultLoggerKey,
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
