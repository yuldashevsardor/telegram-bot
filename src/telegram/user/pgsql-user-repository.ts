import { UserRepository } from "app/telegram/user/user.repository";
import { User } from "app/telegram/user/user";
import { inject, injectable } from "inversify";
import { Database, Sql } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import { UserNotFound } from "app/telegram/user/user.errors";
import { UserRow } from "app/telegram/user/pgsql-user-repository.types";
import dayjs from "dayjs";

@injectable()
export class PgSqlUserRepository implements UserRepository {
    private readonly sql: Sql;

    public constructor(@inject<Database>(Tokens.Platform.Database) database: Database) {
        this.sql = database.sql;
    }

    public async delete(id: number): Promise<void> {
        await this.sql`
            delete
            from users
            where id = ${id}
        `;
    }

    public async existsById(id: number): Promise<boolean> {
        const rows = await this.sql`
            select id
            from users
            where id = ${id}
        `;

        return rows.length !== 0;
    }

    public async getById(id: number): Promise<User> {
        const rows = await this.sql<UserRow[]>`
            select *
            from users
            where id = ${id} limit 1
        `;

        const row = rows[0];

        if (row === undefined) {
            throw UserNotFound.byId(id);
        }

        return PgSqlUserRepository.rowToEntity(row);
    }

    public async save(user: User): Promise<void> {
        const row = PgSqlUserRepository.entityToRow(user);

        await this.sql`
            insert into users ${this.sql(row)} on conflict (id)
            do
            update set ${this.sql(row, "first_name", "last_name", "username", "is_bot", "last_active_time", "updated_time")}
        `;
    }

    private static rowToEntity(row: UserRow): User {
        return new User({
            id: row.id,
            firstname: row.first_name,
            lastname: row.last_name,
            username: row.username,
            isBot: row.is_bot,
            lastActiveTime: dayjs(row.last_active_time),
            createdTime: dayjs(row.created_time),
            updatedTime: dayjs(row.updated_time),
        });
    }

    private static entityToRow(user: User): UserRow {
        return {
            id: user.id,
            first_name: user.firstname,
            last_name: user.lastname,
            username: user.username,
            is_bot: user.isBot,
            last_active_time: user.lastActiveTime.toDate(),
            created_time: user.createdTime.toDate(),
            updated_time: user.updatedTime.toDate(),
        };
    }
}
