import { container } from "app/infrastructure/container/container";
import { Infrastructure } from "app/infrastructure/container/symbols/infrastructure";
import { Database, Sql } from "app/infrastructure/database/database";

function getSql(): Sql {
    const database = container.get<Database>(Infrastructure.Database);

    return database.sql;
}

export function PgSql(): (target: any, propertyKey: string) => void {
    return (target: any, propertyKey: string) => {
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
