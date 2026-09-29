import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { RuntimeError } from "app/shared/errors";

// The database of a run is created by test/database-hook.ts; why the name arrives in a variable
// of its own rather than in DATABASE_NAME is there too.
export function testDatabaseName(): string {
    const name = process.env["TEST_DATABASE_NAME"];

    if (name === undefined) {
        throw new RuntimeError("TEST_DATABASE_NAME is not set: test/database-hook.ts did not run, rebuild the image (make rebuild)");
    }

    return name;
}

// The database settings of the config, pointed at the database of the run.
export async function testDatabaseSettings(): Promise<DatabaseSettings> {
    const env = await new ConfigEnvStorage().load();
    // The config requires BOT_TOKEN while a database spec needs only the database: without the
    // substitution it would depend on the token in .env.
    const settings = new ConfigValuesBuilder().build({ ...env, BOT_TOKEN: "test-token" }).database;

    return { ...settings, database: testDatabaseName() };
}
