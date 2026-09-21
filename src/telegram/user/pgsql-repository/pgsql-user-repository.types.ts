// A snapshot of the users columns as postgres returns and takes them: snake_case, Date
// instead of Dayjs and id as a string — without a types setting the driver returns bigint
// as a string, so that precision past 2^53 is not lost. A detail of the storage and not the
// vocabulary of the entity, hence it lies next to its only consumer, PgSqlUserRepository,
// and not in user.types.ts.
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
