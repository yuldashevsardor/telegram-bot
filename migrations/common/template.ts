/* eslint-disable @typescript-eslint/no-unused-vars */
import { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";
import { commonShorthands } from "./common/utils";

export const shorthands: ColumnDefinitions = commonShorthands;

export async function up(pgm: MigrationBuilder): Promise<void> {}

export async function down(pgm: MigrationBuilder): Promise<void> {}
