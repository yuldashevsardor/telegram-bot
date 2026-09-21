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
