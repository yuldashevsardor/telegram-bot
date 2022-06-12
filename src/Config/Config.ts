import * as dotenv from "dotenv";
import path from "path";
import { Limit } from "App/Modules/SlotManager/SlotManager";
import { injectable } from "inversify";
import { Level, Levels } from "App/Services/Logger/Types";

dotenv.config();

export type Environment = "production" | "development" | "testing";

@injectable()
export class Config {
    public readonly environment: Environment;
    public readonly isProduction: boolean;

    public readonly root: string;
    public readonly tempDir: string;
    public readonly pythonPath: string;
    public readonly fontForgePath: string;

    public readonly managerLimits: {
        common: Limit;
        private: Limit;
        group: Limit;
    };

    public readonly broker: {
        sleepInterval: number;
    };

    public readonly bot: {
        token: string;
    };

    public readonly logger: {
        levels: Array<Level>;
    };

    public constructor() {
        this.environment = Config.getEnvAsString("ENVIRONMENT", "development") as Environment;
        this.isProduction = this.environment === "production";

        this.root = process.cwd();
        this.tempDir = Config.getEnvAsString("TEMP_DIR", path.join(this.root, "temp"));
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

        this.logger = {
            levels: [],
        };

        const logLevels = Config.getEnvAsArray("LOG_LEVELS", []).map((level) => level.toUpperCase());

        if (!logLevels.length) {
            if (this.isProduction) {
                this.logger.levels = [Level.WARNING, Level.ERROR, Level.CRITICAL];
            } else {
                this.logger.levels = Levels;
            }
        } else if (logLevels.includes("*") || logLevels.includes("ALL")) {
            this.logger.levels = Levels;
        } else {
            this.logger.levels = logLevels as Array<Level>;
        }
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
}
