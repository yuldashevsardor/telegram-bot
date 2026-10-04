import { expect } from "chai";
import { sleep } from "app/shared/utils";

// Longer than any notification of a passing run takes to arrive, shorter than the timeout of the
// specs that wait for one: a notification that never comes fails with its own message.
export const NOTIFICATION_DEADLINE_MS = 5_000;

export async function waitUntil(condition: () => boolean | Promise<boolean>, failure: string): Promise<void> {
    const deadline = Date.now() + NOTIFICATION_DEADLINE_MS;

    while (!(await condition())) {
        if (Date.now() > deadline) {
            expect.fail(failure);
        }

        await sleep(5);
    }
}
