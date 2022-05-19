import * as dotenv from "dotenv";
import { Limit } from "./modules/slot-manager/SlotManager";

dotenv.config();

function convertToBoolean(val: string): boolean {
    return /^true$/i.test(val);
}

function convertToInteger(val: string): number {
    return parseInt(val);
}

const env = process.env;

export type Environment = "production" | "development" | "testing";
export const environment: Environment = (env.ENVIRONMENT as Environment) || "development";

export type Limits = {
    common: Limit;
    private: Limit;
    group: Limit;
};
export const managerLimits: Limits = {
    common: {
        number: convertToInteger(process.env.LIMIT_COMMON_NUMBER) || 30,
        interval: convertToInteger(process.env.LIMIT_COMMON_INTERVAL) || 1000, // 1 секунда
    },
    private: {
        number: convertToInteger(process.env.LIMIT_PRIVATE_NUMBER) || 1,
        interval: convertToInteger(process.env.LIMIT_PRIVATE_INTERVAL) || 1000, // 1 секунда
    },
    group: {
        number: convertToInteger(process.env.LIMIT_GROUP_NUMBER) || 20,
        interval: convertToInteger(process.env.LIMIT_GROUP_INTERVAL) || 60 * 1000, // 1 минута
    },
};

export const broker = {
    sleepInterval: convertToInteger(process.env.BROKER_SLEEP_INTERVAL) || 1000,
};

export const bot = {
    token: process.env.BOT_TOKEN || "",
};

export const tempDir = process.env.TEMP_DIR || "/tmp";

export const pythonPath = process.env.PYTHON_PATH;
