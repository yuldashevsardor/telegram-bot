import { UserRepository } from "App/Domain/User/UserRepository";
import { User } from "App/Domain/User/User";
import { injectable } from "inversify";
import { Sql } from "App/Infrastructure/Database/Database";
import { PgSql } from "App/Infrastructure/Database/PgSql";
import { UserNotFound } from "App/Domain/User/Errors";
import { UserRow } from "App/Domain/User/Types";
import dayjs from "dayjs";

@injectable()
export class PgSqlUserRepository implements UserRepository {
    @PgSql()
    private readonly sql!: Sql;

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

        if (!rows.length) {
            throw UserNotFound.byId(id);
        }

        return PgSqlUserRepository.rowToEntity(rows[0]);
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
