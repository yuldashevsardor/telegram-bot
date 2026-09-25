// A snapshot of the users columns as postgres returns and takes them: snake_case, Date
// instead of Dayjs, and id as a string. Without a types setting the driver returns bigint as a
// string, so that precision past 2^53 is not lost. The type belongs to the storage, not to the
// entity, so it lies next to its only consumer, PgSqlUserRepository, not in user.types.ts.
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
