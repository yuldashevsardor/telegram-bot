import { container } from "app/infrastructure/container/container";
import { Tokens } from "app/common/tokens";
import { Database, Sql } from "app/infrastructure/database/database";

function getSql(): Sql {
    const database = container.get<Database>(Tokens.Infrastructure.Database);

    return database.sql;
}

export function PgSql(): (target: object, propertyKey: string) => void {
    return (target: object, propertyKey: string) => {
        let sql: Sql;

        const getter = (): Sql => {
            if (sql === undefined) {
                sql = getSql();
            }

            return sql;
        };

        Object.defineProperty(target, propertyKey, {
            get: getter,
        });
    };
}
