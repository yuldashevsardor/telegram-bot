import postgres from "postgres";
import { injectable } from "inversify";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { configValue } from "app/shared/config-value";

const CLOSE_TIMEOUT_SECONDS = 5;

export type Sql = ReturnType<typeof postgres>;

@injectable()
export class Database {
    public readonly sql: Sql;

    public constructor(settings: DatabaseSettings = configValue("database"), isProduction: boolean = configValue("isProduction")) {
        this.sql = postgres({
            host: settings.host,
            port: settings.port,
            database: settings.database,
            username: settings.username,
            password: settings.password,
            // Not query logging: postgres takes debug as a callback (the typeof === "function"
            // check in its connection.js), so with true the driver prints nothing and nothing
            // bypasses Logger. true only makes the fields of a failed query's error enumerable,
            // and so they reach the payload of the log (docs/architecture/storage.md).
            debug: !isProduction,
            max: settings.connection.max,
            idle_timeout: settings.connection.idleTimeout,
            max_lifetime: settings.connection.maxLifetime,
        });
    }

    public async check(): Promise<void> {
        await this.sql`select 1`;
    }

    public async close(): Promise<void> {
        await this.sql.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    }
}
