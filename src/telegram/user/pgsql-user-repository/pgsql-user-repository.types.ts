// Снимок колонок таблицы users как их отдаёт и принимает postgres: snake_case, Date
// вместо Dayjs и id строкой — bigint драйвер без настройки types отдаёт строкой, чтобы не
// терять точность за 2^53. Деталь хранилища, а не словарь сущности, — поэтому лежит рядом
// с единственным потребителем, PgSqlUserRepository, а не в user.types.ts.
export type UserRow = {
    id: string;
    first_name: string;
    last_name: string;
    username: string;
    is_bot: boolean;
    last_active_time: Date;
    created_time: Date;
    updated_time: Date;
};
