// The measurement of the inbox load test (docs/architecture/inbox-load-test.md): calls every method
// of the real InboxStore that runs SQL against the database of docker-compose.load.yml and prints how
// long each call took. The plans of their statements land in the log of that database through
// auto_explain; make load-inbox-measure prints both.
import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import type { Update } from "@grammyjs/types";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import type { Sql } from "app/platform/database/database";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { RuntimeError } from "app/shared/errors";
import { sleep } from "app/shared/utils";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type {
    ClaimedInboxUpdate,
    InboxAttemptError,
    InboxGroupKey,
    InboxUpdateInput,
    InboxWorker,
} from "app/telegram/inbox/store/inbox-store.types";

// CLAIM_LIMIT of InboxUpdateSource: what the worker asks for.
const WORKER_CLAIM_LIMIT = 1;
// A batch: nothing in the inbox sets one yet, so it is the largest batch of the outbox load test,
// for comparison.
const BATCH_CLAIM_LIMIT = 30;
// Every measured claim is followed by the completion of what it gave out, and every other method
// is called as many times. A few are enough to tell the first, cold one from the rest and to see the
// spread.
const CALLS_PER_METHOD = 15;
// The lease of the batch left to expire. INBOX_LEASE_DURATION of .env.dist is 10 minutes, which the
// run would wait out for nothing: the recovery reads the leases the same way however long they were.
const ABANDONED_LEASE_DURATION_MS = 1_000;
// Past the end of the lease, so that the leases left by the claim have expired by the database clock.
const LEASE_EXPIRY_MARGIN_MS = 1_000;
// The retried group is ready again at once: in the layout of the hot group it is the only one to
// claim next.
const RETRY_DELAY_MS = 0;
// The groups blocked and then unblocked, half retried and half skipped: CALLS_PER_METHOD of each.
const UNBLOCKED_GROUP_COUNT = 2 * CALLS_PER_METHOD;
// POLL_LIMIT of InboxPollingSource: the most updates one getUpdates gives, and so one push.
const PUSH_BATCH_UPDATE_COUNT = 100;
// The file sizes of the fonts in the updates, as the fills give them.
const MIN_FILE_SIZE_BYTES = 100_000;
const FILE_SIZE_SPREAD_BYTES = 400_000;
const MS_PER_SECOND = 1_000;
// The groups of make load-inbox-fill-done at its default: a push goes to one of them, as a returning
// user's does. A fill of fewer groups leaves most pushes to groups with no history.
const HISTORY_GROUP_COUNT = 1_000_000;

const WORKER: InboxWorker = { host: hostname(), pid: process.pid, workerId: "load-test" };

const ATTEMPT_ERROR: InboxAttemptError = {
    kind: InboxFailureKind.Unexpected,
    name: "RuntimeError",
    message: "The font could not be converted",
};

class InboxLoadTest {
    // The update_id the next push takes.
    private nextPushedUpdateId = 0;

    // abandoningStore claims the batch left to expire: its lease is ABANDONED_LEASE_DURATION_MS. sql
    // reads the last update_id stored, so the pushes take new ones however many runs came before.
    public constructor(private readonly store: InboxStore, private readonly abandoningStore: InboxStore, private readonly sql: Sql) {}

    // The settings of .env, with DATABASE_HOST of the load-test database that make load-inbox-measure
    // sets.
    public static async main(): Promise<void> {
        const env = await new ConfigEnvStorage().load();
        const config = new ConfigValuesBuilder().build(env);
        const database = new Database(config.database, config.isProduction);
        const logger = new ConsoleLogger(new RequestContext());
        const store = new InboxStore(database, logger, config.inbox.leaseDurationMs, config.inbox.cleanup);
        const abandoningStore = new InboxStore(database, logger, ABANDONED_LEASE_DURATION_MS, config.inbox.cleanup);

        try {
            await new InboxLoadTest(store, abandoningStore, database.sql).run();
        } finally {
            await database.close();
        }
    }

    // The unblocking comes last: on a volume whose index of the failed updates is missing its calls
    // take minutes (docs/architecture/inbox-load-test.md, "The unblocking"), and one cancelled by the
    // statement timeout ends the run without the calls after it.
    public async run(): Promise<void> {
        await this.measure("listenReady()", () => this.store.listenReady(() => {}));
        await this.measureClaims(WORKER_CLAIM_LIMIT);
        await this.measureClaims(BATCH_CLAIM_LIMIT);
        await this.measureLeaseRecovery();
        await this.measureFailures();
        await this.measurePushes();
        await this.measureCleanup();
        await this.measureUnblocking();
    }

    private async measureClaims(limit: number): Promise<void> {
        for (let claimNumber = 1; claimNumber <= CALLS_PER_METHOD; claimNumber++) {
            const claimedUpdates = await this.measure(`claim(${limit})`, () => this.claimOrThrow(this.store, limit));

            for (const claimedUpdate of claimedUpdates) {
                await this.measure(`markAsDone() of update ${claimedUpdate.updateId}, group ${claimedUpdate.chatId}`, () =>
                    this.store.markAsDone(claimedUpdate),
                );
            }
        }
    }

    // The inbox has no limits to hold a claim back: a claim that gives out nothing means the layout
    // has no ready group with a pending head, a missing layout or a status or state the store does
    // not know.
    private async claimOrThrow(store: InboxStore, limit: number): Promise<ClaimedInboxUpdate[]> {
        const claimedUpdates = await store.claim(limit, WORKER);

        if (claimedUpdates.length === 0) {
            throw new RuntimeError(
                "No update to claim: fill a layout (make load-inbox-fill-pending) with the values of InboxStatus and InboxGroupState",
            );
        }

        return claimedUpdates;
    }

    // The call of every INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL finds no lease as a rule, and the one
    // after a node died finds the groups it held: a batch is claimed and left until its lease expires.
    // Its updates are then marked done, not retried as InboxFailureHandler would, so that the cleanup
    // that follows sees the groups as the claims leave them.
    private async measureLeaseRecovery(): Promise<void> {
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        const abandonedUpdates = await this.measure(`claim(${BATCH_CLAIM_LIMIT}), left to expire`, () =>
            this.claimOrThrow(this.abandoningStore, BATCH_CLAIM_LIMIT),
        );
        await sleep(ABANDONED_LEASE_DURATION_MS + LEASE_EXPIRY_MARGIN_MS);
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        for (const abandonedUpdate of abandonedUpdates) {
            await this.store.markAsDone(abandonedUpdate);
        }
    }

    // The calls of a handler that runs long or fails: an extension of the lease and a retry of the same
    // claim, then a failure that lets the group go on. Their claims are not measured: they are the
    // claims of measureClaims().
    private async measureFailures(): Promise<void> {
        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const [claimedUpdate] = await this.claimOrThrow(this.store, WORKER_CLAIM_LIMIT);

            await this.measure("extendLease()", () => this.store.extendLease(claimedUpdate!));
            await this.measure("retry()", () => this.store.retry(claimedUpdate!, ATTEMPT_ERROR, RETRY_DELAY_MS));
        }

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const [claimedUpdate] = await this.claimOrThrow(this.store, WORKER_CLAIM_LIMIT);

            await this.measure("markAsFailed()", () => this.store.markAsFailed(claimedUpdate!, ATTEMPT_ERROR));
        }
    }

    // The polling source pushes what one getUpdates gave: one update or a full batch. Each update goes
    // to a group of the history drawn at random, so most of the groups have no row in the groups table
    // and the push inserts it, as for a user who comes back after the cleanup removed their idle group.
    private async measurePushes(): Promise<void> {
        const [lastStored] = await this.sql<{ update_id: string }[]>`SELECT max(update_id) AS update_id FROM telegram_inbox`;
        this.nextPushedUpdateId = Number(lastStored!.update_id) + 1;

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const input = this.nextPushedUpdate();

            await this.measure("push()", () => this.store.push(input));
        }

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const inputs = Array.from({ length: PUSH_BATCH_UPDATE_COUNT }, () => this.nextPushedUpdate());

            await this.measure(`pushBatch() of ${PUSH_BATCH_UPDATE_COUNT}`, () => this.store.pushBatch(inputs));
        }
    }

    // A font sent as a document, as the updates of the fills are.
    private nextPushedUpdate(): InboxUpdateInput {
        const updateId = this.nextPushedUpdateId++;
        const groupId = randomInt(1, HISTORY_GROUP_COUNT + 1);
        const update: Update = {
            update_id: updateId,
            message: {
                message_id: updateId,
                date: Math.floor(Date.now() / MS_PER_SECOND),
                chat: { id: groupId, type: "private", first_name: "User" },
                from: { id: groupId, is_bot: false, first_name: "User", language_code: "ru" },
                document: {
                    file_name: `font-${updateId}.ttf`,
                    mime_type: "font/ttf",
                    file_id: `BQACAgIAAxkBAAIBY2Zk${updateId}`,
                    file_unique_id: `AgAD${updateId}`,
                    file_size: MIN_FILE_SIZE_BYTES + (updateId % FILE_SIZE_SPREAD_BYTES),
                },
            },
        };

        return { userId: groupId, chatId: groupId, update: update };
    }

    // A full batch is followed by another call, as InboxMaintenance does, down to the call that
    // deletes nothing. The count of the blocked groups is the other call of the maintenance.
    private async measureCleanup(): Promise<void> {
        for (;;) {
            const deletedCount = await this.measure("deleteFinishedUpdates()", () => this.store.deleteFinishedUpdates());

            if (deletedCount === 0) {
                break;
            }
        }

        await this.measure("deleteIdleGroups()", () => this.store.deleteIdleGroups());

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            await this.measure("countBlockedGroups()", () => this.store.countBlockedGroups());
        }
    }

    // Each unblock takes the group the run has just blocked: its key is known from the claim, and its
    // failed update is the newest of the group, as after a failure in production. The blocked groups
    // of the layout are left to countBlockedGroups().
    private async measureUnblocking(): Promise<void> {
        for (let groupNumber = 1; groupNumber <= UNBLOCKED_GROUP_COUNT; groupNumber++) {
            const [claimedUpdate] = await this.claimOrThrow(this.store, WORKER_CLAIM_LIMIT);
            const groupKey: InboxGroupKey = { userId: claimedUpdate!.userId, chatId: claimedUpdate!.chatId };

            await this.measure("markAsFailedAndBlockGroup()", () => this.store.markAsFailedAndBlockGroup(claimedUpdate!, ATTEMPT_ERROR));

            if (groupNumber % 2 === 1) {
                // The update unblocked is returned, not a count, so it is left out of the output.
                await this.measure("retryBlockedGroup()", async () => {
                    await this.store.retryBlockedGroup(groupKey);
                });
            } else {
                await this.measure("skipBlockedGroup()", async () => {
                    await this.store.skipBlockedGroup(groupKey);
                });
            }
        }
    }

    private async measure<Returned>(call: string, run: () => Promise<Returned>): Promise<Returned> {
        const startedAtMs = performance.now();
        const returned = await run();
        const elapsedMs = performance.now() - startedAtMs;

        process.stdout.write(`${call}: ${elapsedMs.toFixed(1)} ms${this.describe(returned)}\n`);

        return returned;
    }

    private describe(returned: unknown): string {
        // A count of deleted rows or of blocked groups, whichever the call returns.
        if (typeof returned === "number") {
            return `, returned ${returned}`;
        }

        if (typeof returned === "boolean") {
            return `, ${returned}`;
        }

        if (Array.isArray(returned)) {
            return `, ${returned.length} items`;
        }

        return "";
    }
}

// A rejection ends the process with its stack and a non-zero code, so nothing is caught here.
void InboxLoadTest.main();
