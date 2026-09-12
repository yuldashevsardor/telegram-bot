import postgres from "postgres";
import { injectable } from "inversify";
import { DatabaseSettings } from "app/infrastructure/database/database.types";
import { InjectConfig } from "app/common/inject-config";

const CLOSE_TIMEOUT_SECONDS = 5;

export type Sql = ReturnType<typeof postgres>;

@injectable()
export class Database {
    public readonly sql: Sql;

    public constructor(@InjectConfig("database") settings: DatabaseSettings, @InjectConfig("isProduction") isProduction: boolean) {
        this.sql = postgres({
            host: settings.host,
            port: settings.port,
            database: settings.database,
            username: settings.username,
            password: settings.password,
            // debug у postgres — колбэк, а не флаг: при значении true драйвер запросы
            // никуда не печатает (проверка typeof === "function" в его connection.js), он
            // лишь делает query и parameters перечислимыми в ошибке, и они доходят до
            // payload лога. Мимо Logger вывод не идёт.
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
