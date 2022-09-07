import { StorageAdapter } from "grammy";
import { SessionPayload, SessionRow } from "App/Infrastructure/Bot/Session/Types";
import { Sql } from "App/Infrastructure/Database/Database";
import { injectable } from "inversify";
import { PgSql } from "App/Infrastructure/Database/PgSql";

@injectable()
export class PgSqlStorage implements StorageAdapter<SessionPayload> {
    @PgSql()
    private readonly sql!: Sql;

    public async delete(key: string): Promise<void> {
        await this.sql`
            delete
            from sessions
            where key = ${key}
        `;
    }

    public async read(key: string): Promise<SessionPayload | undefined> {
        const rows = await this.sql<SessionRow[]>`
            select *
            from sessions
            where key = ${key}
        `;

        if (!rows.length) {
            return undefined;
        }

        return rows[0].value;
    }

    public async write(key: string, value: SessionPayload): Promise<void> {
        await this.sql`
            insert into sessions
            values (${key}, ${this.sql.json(value)}) on conflict (key) do
            update set
                value = EXCLUDED.value,
                updated_time = now()
        `;
    }
}
