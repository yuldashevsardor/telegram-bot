import { StorageAdapter } from "grammy";
import { SessionPayload } from "App/Infrastructure/Bot/Session/Types";
import { Database, Sql } from "App/Infrastructure/Database/Database";
import { inject, injectable } from "inversify";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { Row } from "postgres";

@injectable()
export class PgSqlSessionRepository implements StorageAdapter<SessionPayload> {
    private readonly sql: Sql;

    public constructor(@inject<Database>(Infrastructure.Database) private db: Database) {
        this.sql = db.sql;
    }

    public async delete(key: string): Promise<void> {
        await this.sql`
            delete
            from sessions
            where key = ${key}
        `;
    }

    public async read(key: string): Promise<SessionPayload | undefined> {
        const rows = await this.sql<Row[]>`
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
            values (${key}, ${this.sql.json(value)}) on conflict (key)
            do
            update set value = ${this.sql.json(value)}, updated_time = now()
        `;
    }
}
