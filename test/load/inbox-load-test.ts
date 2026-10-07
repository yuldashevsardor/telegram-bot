// The measurement of the inbox load test (docs/architecture/inbox-load-test.md): calls the claim, the
// completion, the lease recovery and the cleanup of the real InboxStore against the database of
// docker-compose.load.yml and prints how long each call took. The plans of their statements land in
// the log of that database through auto_explain; make load-inbox-measure prints both.
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { RuntimeError } from "app/shared/errors";
import { sleep } from "app/shared/utils";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";

// CLAIM_LIMIT of InboxUpdateSource: what the worker asks for.
const WORKER_CLAIM_LIMIT = 1;
// A batch: nothing in the inbox sets one yet, so it is the largest batch of the outbox load test,
// for comparison.
const BATCH_CLAIM_LIMIT = 30;
// Every measured claim is followed by the completion of what it gave out. A few are enough to tell
// the first, cold one from the rest and to see the spread.
const CLAIMS_PER_LIMIT = 15;
// The lease of the batch left to expire. INBOX_LEASE_DURATION of .env.dist is 10 minutes, which the
// run would wait out for nothing: the recovery reads the leases the same way however long they were.
const ABANDONED_LEASE_DURATION_MS = 1_000;
// Past the end of the lease, so that the leases left by the claim have expired by the database clock.
const LEASE_EXPIRY_MARGIN_MS = 1_000;

const WORKER: InboxWorker = { host: hostname(), pid: process.pid, workerId: "load-test" };

class InboxLoadTest {
    // abandoningStore claims the batch left to expire: its lease is ABANDONED_LEASE_DURATION_MS.
    public constructor(private readonly store: InboxStore, private readonly abandoningStore: InboxStore) {}

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
            await new InboxLoadTest(store, abandoningStore).run();
        } finally {
            await database.close();
        }
    }

    public async run(): Promise<void> {
        await this.measureClaims(WORKER_CLAIM_LIMIT);
        await this.measureClaims(BATCH_CLAIM_LIMIT);
        await this.measureLeaseRecovery();
        await this.measureCleanup();
    }

    private async measureClaims(limit: number): Promise<void> {
        for (let claimNumber = 1; claimNumber <= CLAIMS_PER_LIMIT; claimNumber++) {
            const claimedUpdates = await this.claimOrThrow(`claim(${limit})`, this.store, limit);

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
    private async claimOrThrow(label: string, store: InboxStore, limit: number): Promise<ClaimedInboxUpdate[]> {
        const claimedUpdates = await this.measure(label, () => store.claim(limit, WORKER));

        if (claimedUpdates.length === 0) {
            throw new RuntimeError(
                "No update to claim: fill a layout (make load-inbox-fill-pending) with the values of InboxStatus and InboxGroupState",
            );
        }

        return claimedUpdates;
    }

    // The call of every INBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL finds no lease as a rule, and the one after a node died finds
    // the groups it held: a batch is claimed and left until its lease expires. Its updates are then
    // marked done, not retried as InboxFailureHandler would, so that the cleanup that follows sees
    // the groups as the claims leave them.
    private async measureLeaseRecovery(): Promise<void> {
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        const abandonedUpdates = await this.claimOrThrow(
            `claim(${BATCH_CLAIM_LIMIT}), left to expire`,
            this.abandoningStore,
            BATCH_CLAIM_LIMIT,
        );
        await sleep(ABANDONED_LEASE_DURATION_MS + LEASE_EXPIRY_MARGIN_MS);
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        for (const abandonedUpdate of abandonedUpdates) {
            await this.store.markAsDone(abandonedUpdate);
        }
    }

    // A full batch is followed by another call, as InboxMaintenance does, down to the call that
    // deletes nothing.
    private async measureCleanup(): Promise<void> {
        for (;;) {
            const deletedCount = await this.measure("deleteFinishedUpdates()", () => this.store.deleteFinishedUpdates());

            if (deletedCount === 0) {
                break;
            }
        }

        await this.measure("deleteIdleGroups()", () => this.store.deleteIdleGroups());
    }

    private async measure<Returned>(call: string, run: () => Promise<Returned>): Promise<Returned> {
        const startedAtMs = performance.now();
        const returned = await run();
        const elapsedMs = performance.now() - startedAtMs;

        process.stdout.write(`${call}: ${elapsedMs.toFixed(1)} ms${this.describe(returned)}\n`);

        return returned;
    }

    private describe(returned: unknown): string {
        if (typeof returned === "number") {
            return `, ${returned} rows`;
        }

        if (Array.isArray(returned)) {
            return `, ${returned.length} items`;
        }

        return "";
    }
}

// A rejection ends the process with its stack and a non-zero code, so nothing is caught here.
void InboxLoadTest.main();
