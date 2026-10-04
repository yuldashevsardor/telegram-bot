import "reflect-metadata";
import { expect } from "chai";
import { Database } from "app/platform/database/database";
import { MS_PER_DAY } from "app/shared/time";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type {
    ClaimedInboxUpdate,
    InboxAttempt,
    InboxAttemptError,
    InboxCleanupSettings,
    InboxUpdateInput,
    InboxWorker,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { testDatabaseSettings } from "test/database.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const USER = 5_000_000_001;
const CHAT = 5_000_000_001;
const LEASE_DURATION_MS = 600_000;
const CLEANUP: InboxCleanupSettings = { doneRetentionMs: MS_PER_DAY, skippedRetentionMs: MS_PER_DAY, batchSize: 10 };
const STOPPING_WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
const OTHER_WORKER: InboxWorker = { host: "node-2", pid: 202, workerId: "worker-1" };
// Far beyond any INBOX_MAX_ATTEMPTS: the release checks no limit.
const MANY_RELEASES = 20;

// What the attempt of a release on stop ends with. Spelled out rather than imported: the releaser
// keeps it private, and the attempts it lands in are read by people.
const NODE_STOPPED: InboxAttemptError = {
    name: "InboxNodeStopped",
    message: "The node stopped before the handler of the update finished: the update is released to any node.",
    kind: InboxFailureKind.Transient,
};

// The releaser runs over the real store, on two clients: the node that stops and the one that takes
// the update over.
describe("InboxLeaseReleaser", function () {
    let database: Database;
    let other: Database;
    let store: InboxStore;
    let otherStore: InboxStore;
    let releaser: InboxLeaseReleaser;

    before(async function () {
        const settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
    });

    beforeEach(async function () {
        const logger = new RecordingLogger();

        store = new InboxStore(database, logger, LEASE_DURATION_MS, CLEANUP);
        otherStore = new InboxStore(other, logger, LEASE_DURATION_MS, CLEANUP);
        releaser = new InboxLeaseReleaser(store);
        await database.sql`TRUNCATE telegram_inbox, telegram_inbox_groups`;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await database?.close();
        await other?.close();
    });

    it("lets another client claim the released update at once, before the lease passes", async function () {
        await store.pushBatch([input(10), input(11)]);
        const [claimed] = await store.claim(10, STOPPING_WORKER);

        await releaser.releaseOnStop(claimed as ClaimedInboxUpdate);

        const reclaimed = await otherStore.claim(10, OTHER_WORKER);

        expect(reclaimed.map(({ updateId, earlierAttempts }) => ({ updateId, earlierAttempts }))).to.deep.equal([
            { updateId: 10, earlierAttempts: 1 },
        ]);
    });

    it("closes the attempt of the stopping worker with the error of the stopped node", async function () {
        await store.push(input(10));
        const [claimed] = await store.claim(10, STOPPING_WORKER);

        await releaser.releaseOnStop(claimed as ClaimedInboxUpdate);

        const [attempt] = await attempts(10);

        expect(attempt).to.deep.include({
            started_at: claimed?.startedAt,
            worker: { host: "node-1", pid: 101, worker_id: "worker-1" },
            error: NODE_STOPPED,
        });
    });

    it("releases the update however many attempts it has made: a stop blocks no group", async function () {
        await store.push(input(10));

        for (let release = 0; release < MANY_RELEASES; release++) {
            const [claimed] = await store.claim(10, STOPPING_WORKER);

            await releaser.releaseOnStop(claimed as ClaimedInboxUpdate);
        }

        expect(await status(10)).to.equal(InboxStatus.Pending);
        expect(await attempts(10)).to.have.lengthOf(MANY_RELEASES);
    });

    async function attempts(updateId: number): Promise<InboxAttempt[]> {
        const [row] = await database.sql<{ attempts: InboxAttempt[] }[]>`SELECT attempts FROM telegram_inbox WHERE update_id = ${updateId}`;

        return row?.attempts ?? [];
    }

    async function status(updateId: number): Promise<string | undefined> {
        const [row] = await database.sql<{ status: string }[]>`SELECT status FROM telegram_inbox WHERE update_id = ${updateId}`;

        return row?.status;
    }
});

// A message update of the user in the chat.
function input(updateId: number): InboxUpdateInput {
    return {
        userId: USER,
        chatId: CHAT,
        update: {
            update_id: updateId,
            message: {
                message_id: updateId,
                date: 0,
                chat: { id: CHAT, type: "private", first_name: "User" },
                from: { id: USER, is_bot: false, first_name: "User" },
                text: "text",
            },
        },
    };
}
