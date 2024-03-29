/* eslint-disable no-restricted-imports,@typescript-eslint/ban-ts-comment */
import { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
// @ts-ignore
import { commonShorthands } from "./common/utils";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {}

export async function down(pgm: MigrationBuilder): Promise<void> {}
