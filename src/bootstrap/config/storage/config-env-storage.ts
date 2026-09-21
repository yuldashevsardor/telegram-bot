import * as dotenv from "dotenv";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

export class ConfigEnvStorage implements ConfigStorage {
    public async load(): Promise<RawConfig> {
        // quiet: since 17.0 dotenv prints a line about loading .env to stdout by default — in
        // production the pino JSON log goes there too, and that line would break its parsing.
        dotenv.config({ quiet: true });

        return { ...process.env };
    }
}
