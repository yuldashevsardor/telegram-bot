/* eslint-disable no-restricted-imports,@typescript-eslint/ban-ts-comment */
import { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
// @ts-ignore
import { commonShorthands } from "./Common/Utils";

const table = "sessions";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable(table, {
        key: {
            type: "string",
            notNull: true,
            unique: true,
        },
        value: {
            type: "jsonb",
            notNull: false,
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
