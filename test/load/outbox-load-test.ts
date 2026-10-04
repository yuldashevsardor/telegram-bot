// The measurement of the outbox load test (docs/architecture/outbox.md, "Load test"): calls the
// pull, the completion, the lease recovery and the cleanup of the real OutboxStore against the
// database of docker-compose.load.yml and prints how long each call took. The plans of their
// statements land in the log of that database through auto_explain; make load-measure prints both.
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import { ConfigEnvStorage } from "app/bootstrap/config/storage/config-env-storage";
import { Database } from "app/platform/database/database";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { RequestContext } from "app/platform/request-context/request-context";
import { RuntimeError } from "app/shared/errors";
import { sleep } from "app/shared/utils";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker } from "app/telegram/outbox/store/outbox-store.types";

// PULL_LIMIT of OutboxMessageSource: what the runner asks for.
const RUNNER_PULL_LIMIT = 1;
// Every measured pull is followed by the completion of what it gave out. A few are enough to tell
// the first, cold one from the rest and to see the spread.
const PULLS_PER_LIMIT = 15;
// The idle time before a batch, in common intervals: a batch of the whole budget moves the next slot
// of the bot one interval ahead, and a full budget is saved up over one more.
const BATCH_IDLE_INTERVALS = 2;
// Past the end of the lease, so that the leases left by the pull have expired by the database clock.
const LEASE_EXPIRY_MARGIN_MS = 1_000;

const WORKER: OutboxWorker = { host: hostname(), pid: process.pid, workerId: "load-test" };
const RESPONSE = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "load test" };

class OutboxLoadTest {
    // The largest batch is the number of the common limit, the most one pull can give out, and its
    // interval is the time the limit takes to save up that budget once its next slot is due.
    public constructor(
        private readonly store: OutboxStore,
        private readonly commonLimit: TelegramLimits["common"],
        private readonly leaseDurationMs: number,
    ) {}

    // The settings of .env, with DATABASE_HOST of the load-test database that make load-measure sets.
    public static async main(): Promise<void> {
        const env = await new ConfigEnvStorage().load();
        const config = new ConfigValuesBuilder().build(env);
        const database = new Database(config.database, config.isProduction);
        const logger = new ConsoleLogger(new RequestContext());
        const store = new OutboxStore(database, logger, config.limits, config.outbox.leaseDurationMs, config.outbox.cleanup);

        try {
            await new OutboxLoadTest(store, config.limits.common, config.outbox.leaseDurationMs).run();
        } finally {
            await database.close();
        }
    }

    public async run(): Promise<void> {
        await this.measurePulls(RUNNER_PULL_LIMIT, 0);
        await this.measurePulls(this.commonLimit.number, this.batchIdleMs());
        await this.measureLeaseRecovery();
        await this.measureCleanup();
    }

    private batchIdleMs(): number {
        return BATCH_IDLE_INTERVALS * this.commonLimit.interval;
    }

    // A pull right when the next slot comes due has a budget of one message, so a batch is pulled
    // after idleMs: a pull that waited only for nextPullInMs would never give out more than one.
    private async measurePulls(limit: number, idleMs: number): Promise<void> {
        for (let pullNumber = 1; pullNumber <= PULLS_PER_LIMIT; pullNumber++) {
            await sleep(idleMs);
            const pullResult = await this.pullDue(limit);

            for (const message of pullResult.messages) {
                await this.measure(`markAsDone() of message ${message.id}, chat ${message.chatId}`, () =>
                    this.store.markAsDone(message, RESPONSE),
                );
            }
        }
    }

    // A pull that answers nothing while the limits hold it back is printed with its 0 messages, and
    // the results of the load test leave it out: it waits out nextPullInMs and pulls again. A pull
    // with no ready chat at all ends the run: the layout is missing, or the fill wrote a status or a
    // state the store does not know.
    private async pullDue(limit: number): Promise<OutboxPullResult> {
        for (;;) {
            const pullResult = await this.measure(`pull(${limit})`, () => this.store.pull(limit, WORKER));

            if (pullResult.messages.length > 0) {
                return pullResult;
            }

            if (pullResult.nextPullInMs === null) {
                throw new RuntimeError(
                    "No ready chat to pull: fill a layout (make load-fill-pending) with the values of OutboxStatus and OutboxChatState",
                );
            }

            await sleep(pullResult.nextPullInMs);
        }
    }

    // The call of every OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL finds no lease as a rule, and the
    // one after a node died finds the chats it held: a batch is pulled and left until its lease
    // expires. Its messages are completed afterwards, as the recovery would, so the cleanup that
    // follows sees the chats as the pulls leave them.
    private async measureLeaseRecovery(): Promise<void> {
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        await sleep(this.batchIdleMs());
        const abandonedPull = await this.pullDue(this.commonLimit.number);
        await sleep(this.leaseDurationMs + LEASE_EXPIRY_MARGIN_MS);
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        for (const message of abandonedPull.messages) {
            await this.store.markAsDone(message, RESPONSE);
        }
    }

    // A full batch is followed by another call, as OutboxMaintenance does, down to the call that
    // deletes nothing.
    private async measureCleanup(): Promise<void> {
        for (;;) {
            const deletedCount = await this.measure("deleteFinishedMessages()", () => this.store.deleteFinishedMessages());

            if (deletedCount === 0) {
                break;
            }
        }

        await this.measure("deleteIdleChats()", () => this.store.deleteIdleChats());
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
            return `, ${returned.length} leases`;
        }

        if (typeof returned === "object" && returned !== null && "messages" in returned) {
            const { messages, nextPullInMs } = returned as OutboxPullResult;

            return `, ${messages.length} messages, nextPullInMs ${nextPullInMs}`;
        }

        return "";
    }
}

// A rejection ends the process with its stack and a non-zero code, so nothing is caught here.
void OutboxLoadTest.main();
