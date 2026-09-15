import { RuntimeError } from "app/shared/errors";

// Базу прогона создаёт test/database-hook.ts; почему имя приходит своей переменной, а не
// DATABASE_NAME, — там же.
export function testDatabaseName(): string {
    const name = process.env["TEST_DATABASE_NAME"];

    if (name === undefined) {
        throw new RuntimeError("TEST_DATABASE_NAME is not set: test/database-hook.ts did not run, rebuild the image (make rebuild)");
    }

    return name;
}
