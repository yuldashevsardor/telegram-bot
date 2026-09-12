import * as dotenv from "dotenv";
import { ConfigStorage } from "app/platform/config/config-storage";

export class ConfigEnvStorage implements ConfigStorage {
    public constructor() {
        // quiet: dotenv с 17.0 по умолчанию печатает в stdout строку о загрузке .env — в проде
        // туда же идёт JSON-лог pino, и эта строка ломала бы его разбор.
        dotenv.config({ quiet: true });
    }

    public get(key: string): string | undefined {
        return process.env[key];
    }
}
