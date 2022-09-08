/* eslint-disable no-restricted-imports,@typescript-eslint/ban-ts-comment */
import { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
// @ts-ignore
import { commonShorthands } from "./Common/Utils";

const table = "users";
const column = "id";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        type: "bigint",
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.alterColumn(table, column, {
        type: "int",
    });
}
