/* eslint-disable no-restricted-imports,@typescript-eslint/ban-ts-comment */
import { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
// @ts-ignore
import { commonShorthands } from "src/infrastructure/database/migrations/common/utils";

const table = "users";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable(table, {
        id: {
            type: "integer",
            notNull: true,
            primaryKey: true,
            comment: "User ID in telegram",
        },
        first_name: {
            type: "text",
            notNull: false,
            comment: "User firstname in telegram",
        },
        last_name: {
            type: "text",
            notNull: false,
            comment: "User lastname in telegram",
        },
        username: {
            type: "text",
            notNull: false,
            comment: "User nickname in telegram",
        },
        is_bot: {
            type: "boolean",
            notNull: true,
        },
        last_active_time: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
        },
        created_time: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
        },
        updated_time: {
            type: "timestampWithTimeZoneNotNullDefaultNow",
        },
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable(table);
}
