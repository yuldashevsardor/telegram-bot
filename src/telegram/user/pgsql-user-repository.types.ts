// Снимок колонок таблицы users как их отдаёт и принимает postgres: snake_case и Date
// вместо Dayjs. Деталь хранилища, а не словарь сущности, — поэтому лежит рядом с
// единственным потребителем, PgSqlUserRepository, а не в user.types.ts.
export type UserRow = {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    is_bot: boolean;
    last_active_time: Date;
    created_time: Date;
    updated_time: Date;
};
