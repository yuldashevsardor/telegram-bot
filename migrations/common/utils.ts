import type { ColumnDefinitions } from "node-pg-migrate";
import { PgLiteral } from "node-pg-migrate";

export const commonShorthands: ColumnDefinitions = {
    timestampWithTimeZoneNotNullDefaultNow: {
        type: "timestamptz",
        notNull: true,
        default: new PgLiteral("now()"),
    },
    createdAt: {
        type: "timestampWithTimeZoneNotNullDefaultNow",
    },
    updatedAt: {
        type: "timestampWithTimeZoneNotNullDefaultNow",
    },
};
