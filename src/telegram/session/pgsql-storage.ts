import { StorageAdapter } from "grammy";
import { SessionPayload, SessionRow } from "app/telegram/session/session.types";
import { Database, Sql } from "app/infrastructure/database/database";
import { inject, injectable } from "inversify";
import { Tokens } from "app/common/tokens";

@injectable()
export class PgsqlStorage implements StorageAdapter<SessionPayload> {
    private readonly sql: Sql;

    public constructor(@inject<Database>(Tokens.Infrastructure.Database) database: Database) {
        this.sql = database.sql;
    }

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

        const row = rows[0];

        if (row === undefined) {
            return undefined;
        }

        return row.value;
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
