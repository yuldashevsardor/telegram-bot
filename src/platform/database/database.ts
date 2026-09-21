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
            // debug in postgres is a callback and not a flag: with true the driver prints
            // no query anywhere (the typeof === "function" check in its connection.js), it
            // only makes the fields of a failed query's error enumerable — query and
            // parameters among them — and from there they reach the payload of the log.
            // Nothing goes out bypassing Logger.
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
