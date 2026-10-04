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
import { sleep } from "app/shared/utils";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker } from "app/telegram/outbox/store/outbox-store.types";

// PULL_LIMIT of OutboxMessageSource: what the runner asks for.
const RUNNER_PULL_LIMIT = 1;
// LIMIT_COMMON_NUMBER of .env.dist: the most one pull can give out.
const BATCH_PULL_LIMIT = 30;
// Every measured pull is followed by the completion of what it gave out. A few are enough to tell
// the first, cold one from the rest and to see the spread.
const PULLS_PER_LIMIT = 15;
// The idle time before a batch, in common intervals: a batch of the whole budget moves the next slot
// of the bot one interval ahead, and a full budget is saved up over one more.
const BATCH_IDLE_INTERVALS = 2;

const WORKER: OutboxWorker = { host: hostname(), pid: process.pid, workerId: "load-test" };
const RESPONSE = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "load test" };

class OutboxLoadTest {
    // commonIntervalMs is LIMIT_COMMON_INTERVAL: the time the common limit takes to save up a full
    // budget once its next slot is due.
    public constructor(private readonly store: OutboxStore, private readonly commonIntervalMs: number) {}

    // The settings of .env, with DATABASE_HOST of the load-test database that make load-measure sets.
    public static async main(): Promise<void> {
        const env = await new ConfigEnvStorage().load();
        const config = new ConfigValuesBuilder().build(env);
        const database = new Database(config.database, config.isProduction);
        const logger = new ConsoleLogger(new RequestContext());
        const store = new OutboxStore(database, logger, config.limits, config.outbox.leaseDurationMs, config.outbox.cleanup);

        try {
            await new OutboxLoadTest(store, config.limits.common.interval).run();
        } finally {
            await database.close();
        }
    }

    public async run(): Promise<void> {
        await this.measurePulls(RUNNER_PULL_LIMIT, 0);
        await this.measurePulls(BATCH_PULL_LIMIT, BATCH_IDLE_INTERVALS * this.commonIntervalMs);
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());
        await this.measureCleanup();
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

    // A pull that answers nothing while the limits hold it back is not measured: it waits out
    // nextPullInMs and pulls again.
    private async pullDue(limit: number): Promise<OutboxPullResult> {
        for (;;) {
            const pullResult = await this.measure(`pull(${limit})`, () => this.store.pull(limit, WORKER));

            if (pullResult.messages.length > 0 || pullResult.nextPullInMs === null) {
                return pullResult;
            }

            await sleep(pullResult.nextPullInMs);
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

    private async measure<Result>(call: string, run: () => Promise<Result>): Promise<Result> {
        const startedAtMs = performance.now();
        const result = await run();
        const elapsedMs = performance.now() - startedAtMs;

        process.stdout.write(`${call}: ${elapsedMs.toFixed(1)} ms${this.describe(result)}\n`);

        return result;
    }

    private describe(result: unknown): string {
        if (typeof result === "number") {
            return `, ${result} rows`;
        }

        if (Array.isArray(result)) {
            return `, ${result.length} leases`;
        }

        if (typeof result === "object" && result !== null && "messages" in result) {
            const { messages, nextPullInMs } = result as OutboxPullResult;

            return `, ${messages.length} messages, nextPullInMs ${nextPullInMs}`;
        }

        return "";
    }
}

// A rejection ends the process with its stack and a non-zero code, so nothing is caught here.
void OutboxLoadTest.main();
