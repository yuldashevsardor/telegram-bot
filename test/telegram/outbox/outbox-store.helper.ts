import { expect } from "chai";
import type { Database } from "app/platform/database/database";
import type { InboxChannel } from "app/telegram/inbox/store/inbox-store.types";
import type { OutboxChannel } from "app/telegram/outbox/store/outbox-store.types";
import { sleep } from "app/shared/utils";

// Longer than any notification of a passing run takes to arrive, shorter than the timeout of the
// specs that wait for one: a notification that never comes fails with its own message.
export const NOTIFICATION_DEADLINE_MS = 5_000;

// The payloads of the notifications of a channel, from the moment the listening starts.
export async function listenTo(database: Database, channel: OutboxChannel | InboxChannel): Promise<string[]> {
    const payloads: string[] = [];
    await database.sql.listen(channel, (payload) => payloads.push(payload));

    return payloads;
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, failure: string): Promise<void> {
    const deadline = Date.now() + NOTIFICATION_DEADLINE_MS;

    while (!(await condition())) {
        if (Date.now() > deadline) {
            expect.fail(failure);
        }

        await sleep(5);
    }
}
