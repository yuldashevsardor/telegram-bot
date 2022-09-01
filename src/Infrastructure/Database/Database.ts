import postgres from "postgres";
import { injectable } from "inversify";
import { DatabaseSettings } from "App/Infrastructure/Database/Types";
import { ConfigValue } from "App/Infrastructure/Config/ConfigValue";

export type Sql = ReturnType<typeof postgres>;

@injectable()
export class Database {
    @ConfigValue<DatabaseSettings>("database")
    private settings!: DatabaseSettings;

    @ConfigValue<boolean>("isProduction")
    private isProduction!: boolean;

    public readonly sql: Sql;

    public constructor() {
        this.sql = postgres({
            host: this.settings.host,
            port: this.settings.port,
            database: this.settings.database,
            username: this.settings.username,
            password: this.settings.password,
            debug: !this.isProduction,
            max: this.settings.connection.max,
            idle_timeout: this.settings.connection.idleTimeout,
            max_lifetime: this.settings.connection.maxLifetime,
        });
    }
}
