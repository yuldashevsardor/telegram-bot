import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";
import path from "path";
import { injectable } from "inversify";
import { Level, Levels } from "App/Domain/Logger/Types";
import { InvalidConfigError } from "App/Common/Errors";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { Limits } from "App/Domain/Planner/Types";
import { DatabaseSettings } from "App/Infrastructure/Database/Types";

dotenvExpand.expand(dotenv.config());

type Logger = {
    default: symbol;
    levels: Array<Level>;
};

export type Environment = "production" | "development" | "testing";

@injectable()
export class Config {
    private static readonly allowedLoggerTypes = ["ConsoleLogger", "PinoLogger"];

    public readonly environment: Environment;
    public readonly isProduction: boolean;

    public readonly root: string;
    public readonly tempDir: string;
    public readonly pythonPath: string;
    public readonly fontForgePath: string;

    public readonly managerLimits: Limits;

    public readonly broker: {
        sleepInterval: number;
    };

    public readonly bot: {
        token: string;
    };

    public readonly logger!: Logger;

    public readonly database!: DatabaseSettings;

    public constructor() {
        this.environment = Config.getEnvAsString("ENVIRONMENT", "development") as Environment;
        this.isProduction = this.environment === "production";

        this.root = process.cwd();
        this.tempDir = Config.getEnvAsString("TEMP_DIR", path.join(this.root, "tmp"));
        this.pythonPath = Config.getEnvAsString("PYTHON_PATH", "python");
        this.fontForgePath = Config.getEnvAsString("FONT_FORGE_PATH", "fontforge");

        this.managerLimits = {
            common: {
                number: Config.getEnvAsInteger("LIMIT_COMMON_NUMBER", 30),
                interval: Config.getEnvAsInteger("LIMIT_COMMON_INTERVAL", 1000), // 1 секунда
            },
            private: {
                number: Config.getEnvAsInteger("LIMIT_PRIVATE_NUMBER", 3),
                interval: Config.getEnvAsInteger("LIMIT_PRIVATE_INTERVAL", 1000), // 1 секунда
            },
            group: {
                number: Config.getEnvAsInteger("LIMIT_GROUP_NUMBER", 20),
                interval: Config.getEnvAsInteger("LIMIT_GROUP_INTERVAL", 60 * 1000), // 1 минута
            },
        };

        this.broker = {
            sleepInterval: Config.getEnvAsInteger("BROKER_SLEEP_INTERVAL", 1000),
        };

        this.bot = {
            token: Config.getEnvAsString("BOT_TOKEN"),
        };

        this.logger = Config.getLogger(this.isProduction);
        this.database = Config.getDatabase();
    }

    private static getEnvAsString(name: string, defaultValue = ""): string {
        let value = process.env[name];

        if (value !== undefined) {
            value = value.trim();
        }

        if (value === null || value === undefined || value === "") {
            return defaultValue;
        }

        return value;
    }

    private static getEnvAsInteger(name: string, defaultValue: number): number {
        const value = Config.getEnvAsString(name, "");

        if (value === "") {
            return defaultValue;
        }

        return parseInt(value);
    }

    private static getEnvAsBoolean(name: string, defaultValue: boolean): boolean {
        const value = Config.getEnvAsString(name, "");

        if (value === "") {
            return defaultValue;
        }

        if (/^true$/i.test(value)) {
            return true;
        }

        if (/^false$/i.test(value)) {
            return false;
        }

        return !!parseInt(value);
    }

    private static getEnvAsArray(name: string, defaultValue: Array<string>): Array<string> {
        const value = Config.getEnvAsString(name, "");

        if (value === "") {
            return defaultValue;
        }

        return value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== "");
    }

    private static getLogger(isProduction: boolean): Logger {
        const defaultLoggerKey = Config.getEnvAsString("LOGGER_DEFAULT", "") || (isProduction ? "PinoLogger" : "ConsoleLogger");
        const logLevels = Config.getEnvAsArray("LOGGER_LEVELS", []).map((level) => level.toUpperCase());

        if (!Config.allowedLoggerTypes.includes(defaultLoggerKey)) {
            throw new InvalidConfigError({
                message: "Invalid default logger",
                payload: {
                    got: defaultLoggerKey,
                    allowed: this.allowedLoggerTypes,
                },
            });
        }

        const logger: Logger = {
            default: Infrastructure[defaultLoggerKey],
            levels: [],
        };

        if (!logLevels.length) {
            if (isProduction) {
                logger.levels = [Level.WARNING, Level.ERROR, Level.CRITICAL];
            } else {
                logger.levels = Levels;
            }
        } else if (logLevels.includes("*") || logLevels.includes("ALL")) {
            logger.levels = Levels;
        } else {
            logger.levels = logLevels as Array<Level>;
        }

        return logger;
    }

    private static getDatabase(): DatabaseSettings {
        return {
            host: Config.getEnvAsString("DATABASE_HOST", "localhost"),
            port: Config.getEnvAsInteger("DATABASE_PORT", 5432),
            database: Config.getEnvAsString("DATABASE_NAME", "postgres"),
            username: Config.getEnvAsString("DATABASE_USER_NAME", "docker"),
            password: Config.getEnvAsString("DATABASE_USER_PASSWORD", ""),
            connection: {
                max: Config.getEnvAsInteger("DATABASE_CONNECTION_LIMIT", 10),
                idleTimeout: Config.getEnvAsInteger("DATABASE_CONNECTION_IDLE_TIMEOUT", 10),
                maxLifetime: Config.getEnvAsInteger("DATABASE_CONNECTION_MAX_LIFETIME", 60 * 10),
            },
        };
    }
}
