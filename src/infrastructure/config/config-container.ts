import path from "path";
import { isLevel, Level, Levels } from "app/domain/logger/logger.types";
import { InvalidConfigError } from "app/common/errors";
import { Limits } from "app/domain/planner/planner.types";
import { BrokerSettings } from "app/domain/broker/broker.types";
import { DatabaseSettings } from "app/infrastructure/database/database.types";
import { ConfigStorage } from "app/infrastructure/config/config-storage";

type LoggerConfig = {
    level: Level;
};

export type Environment = "production" | "development" | "testing";

export class ConfigContainer {
    public readonly environment: Environment;
    public readonly isProduction: boolean;

    public readonly rootDir: string;
    public readonly tempDir: string;
    public readonly fontForgePath: string;

    public readonly managerLimits: Limits;

    public readonly broker: BrokerSettings;

    public readonly bot: {
        token: string;
    };

    public readonly gracefulShutdown: {
        timeout: number;
        plannerInterval: number;
    };

    public readonly logger: LoggerConfig;

    public readonly database: DatabaseSettings;

    public constructor(private readonly storage: ConfigStorage) {
        this.environment = this.getString("NODE_ENV", "development") as Environment;
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
        };

        this.gracefulShutdown = {
            timeout: this.getInteger("GRACEFUL_SHUTDOWN_TIMEOUT", 5000),
            plannerInterval: this.getInteger("PLANNER_GRACEFUL_SHUTDOWN_INTERVAL", 3000),
        };

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
            throw new InvalidConfigError({
                message: `Config value "${name}" must be an integer`,
                payload: {
                    got: value,
                },
            });
        }

        return parsed;
    }

    private getLogger(): LoggerConfig {
        const level = this.getString("LOGGER_LEVEL", "").toUpperCase() || (this.isProduction ? Level.WARNING : Level.DEBUG);

        if (!isLevel(level)) {
            throw new InvalidConfigError({
                message: "Invalid logger level",
                payload: {
                    got: level,
                    allowed: Levels,
                },
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
