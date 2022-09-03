import { container } from "App/Infrastructure/Container/Container";
import { Infrastructure } from "App/Infrastructure/Container/Symbols/Infrastructure";
import { Database, Sql } from "App/Infrastructure/Database/Database";

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
