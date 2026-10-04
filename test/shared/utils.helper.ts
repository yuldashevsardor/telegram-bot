import { expect } from "chai";
import { sleep } from "app/shared/utils";

// Longer than any condition of a passing run takes to come true, a notification included, shorter
// than the timeout of the specs that wait for one: a condition that never comes true fails with its
// own message.
export const WAIT_UNTIL_DEADLINE_MS = 5_000;

export async function waitUntil(condition: () => boolean | Promise<boolean>, failure: string): Promise<void> {
    const deadline = Date.now() + WAIT_UNTIL_DEADLINE_MS;

    while (!(await condition())) {
        if (Date.now() > deadline) {
            expect.fail(failure);
        }

        await sleep(5);
    }
}
