import * as dotenv from "dotenv";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { RawConfig } from "app/bootstrap/config/config-container/config-container.types";

export class ConfigEnvStorage implements ConfigStorage {
    public async load(): Promise<RawConfig> {
        // quiet: dotenv с 17.0 по умолчанию печатает в stdout строку о загрузке .env — в проде
        // туда же идёт JSON-лог pino, и эта строка ломала бы его разбор.
        dotenv.config({ quiet: true });

        return { ...process.env };
    }
}
