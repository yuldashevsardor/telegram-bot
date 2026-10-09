// The measurement of the outbox load test (docs/architecture/outbox-load-test.md): calls every
// method of the real OutboxStore that runs SQL, and the read of OutboxFinishedMessageReader that
// OutboxResultWaiter falls back to, against the database of docker-compose.load.yml and prints how
// long each call took. The plans of their statements land in the log of that database through
// auto_explain; make load-measure prints both.
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
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxFinishedMessageReader } from "app/telegram/outbox/outbox-finished-message-reader";
import { serialize } from "app/telegram/outbox/payload-codec/payload-codec";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { OutboxPriority } from "app/telegram/outbox/store/outbox-store.types";
import type {
    OutboxAttemptError,
    OutboxMessageInput,
    OutboxPullResult,
    OutboxWorker,
    PulledOutboxMessage,
} from "app/telegram/outbox/store/outbox-store.types";

// PULL_LIMIT of OutboxMessageSource: what the runner asks for.
const RUNNER_PULL_LIMIT = 1;
// Every measured pull is followed by the completion of what it gave out, and every other method is
// called as many times. A few are enough to tell the first, cold one from the rest and to see the
// spread.
const CALLS_PER_METHOD = 15;
// The idle time before a batch, in common intervals: a batch of the whole budget moves the next slot
// of the bot one interval ahead, and a full budget is saved up over one more.
const BATCH_IDLE_INTERVALS = 2;
// Past the end of the lease, so that the leases left by the pull have expired by the database clock.
const LEASE_EXPIRY_MARGIN_MS = 1_000;
// The limits hold back a pull or two in a row between two that give out messages; this many in a row
// means the ready chats have no head the store can pull.
const MAX_EMPTY_PULLS_IN_A_ROW = 20;
// The retried chat is ready again once its chat limit lets it: in the layout of the hot chat it is
// the only one to pull next.
const RETRY_DELAY_MS = 0;
// The chats blocked and then unblocked, half retried and half skipped. Few: the lookup of the failed
// message reads the whole table (docs/architecture/outbox-load-test.md, "The skewed run"), minutes a
// call.
const UNBLOCKED_CHAT_COUNT = 4;
// The pause of a 429 that asks for no wait: the statement is the same for any duration, and a longer
// one would hold back the pulls of the unblocking after it.
const PAUSE_DURATION_MS = 0;
// BATCH_MESSAGE_COUNT of BulkMessagesCommand, the one caller of pushBatch().
const PUSH_BATCH_MESSAGE_COUNT = 1_000;
// The chats of make load-fill-done at its default: a push goes to one of them, as a reply to a
// returning user does. A fill of fewer chats leaves most pushes to chats with no history.
const HISTORY_CHAT_COUNT = 1_000_000;
// The step between the chats of two pushes in a row: coprime to HISTORY_CHAT_COUNT and near it times
// the golden ratio, so the pushes of a run go to as many chats, spread over them, and every run
// pushes to the same chats as the one before.
const PUSHED_CHAT_STEP = 618_033;
const PUSHED_METHOD = "sendMessage";

const WORKER: OutboxWorker = { host: hostname(), pid: process.pid, workerId: "load-test" };
const RESPONSE = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "load test" };

// A call that fails in a way that lets the chat go on, retried or failed, and one that blocks it, as
// OutboxErrorSerializer writes a GrammyError.
const UNDELIVERABLE_ERROR: OutboxAttemptError = {
    kind: TelegramBotApiFailureKind.Undeliverable,
    name: "GrammyError",
    message: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
};
const UNEXPECTED_ERROR: OutboxAttemptError = {
    kind: TelegramBotApiFailureKind.Unexpected,
    name: "GrammyError",
    message: "Call to 'sendMessage' failed! (400: Bad Request: can't parse entities)",
};

class OutboxLoadTest {
    // The number of the next push, the draw of its chat.
    private pushNumber = 0;

    // The largest batch is the number of the common limit, the most one pull can give out, and its
    // interval is the time the limit takes to save up that budget once its next slot is due.
    public constructor(
        private readonly store: OutboxStore,
        private readonly finishedMessageReader: OutboxFinishedMessageReader,
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
        const finishedMessageReader = new OutboxFinishedMessageReader(database);

        try {
            await new OutboxLoadTest(store, finishedMessageReader, config.limits.common, config.outbox.leaseDurationMs).run();
        } finally {
            await database.close();
        }
    }

    // The unblocking comes last: its calls are the slowest, and one cancelled by the statement timeout
    // ends the run without the calls after it.
    public async run(): Promise<void> {
        await this.measure("listenReady()", () => this.store.listenReady(() => {}));
        await this.measurePulls(RUNNER_PULL_LIMIT, 0);
        const batches = await this.measurePulls(this.commonLimit.number, this.batchIdleMs());
        await this.measureLeaseRecovery();
        await this.measureFailures();
        await this.measureFinishedReads(batches);
        await this.measurePushes();
        await this.measurePauses();
        await this.measureMaintenance();
        await this.measureUnblocking();
    }

    private batchIdleMs(): number {
        return BATCH_IDLE_INTERVALS * this.commonLimit.interval;
    }

    // A pull right when the next slot comes due has a budget of one message, so a batch is pulled
    // after idleMs: a pull that waited only for nextPullInMs would never give out more than one.
    // Returns the messages of each pull.
    private async measurePulls(limit: number, idleMs: number): Promise<PulledOutboxMessage[][]> {
        const batches: PulledOutboxMessage[][] = [];

        for (let pullNumber = 1; pullNumber <= CALLS_PER_METHOD; pullNumber++) {
            await sleep(idleMs);
            const pullResult = await this.pullDue(`pull(${limit})`, limit);

            for (const message of pullResult.messages) {
                await this.measure(`markAsDone() of message ${message.id}, chat ${message.chatId}`, () =>
                    this.store.markAsDone(message, RESPONSE),
                );
            }

            batches.push(pullResult.messages);
        }

        return batches;
    }

    // A pull that answers nothing while the limits hold it back is printed with its 0 messages, and
    // the results of the load test leave it out: it waits out nextPullInMs and pulls again. The run
    // ends on a layout the store cannot pull: with no ready chat (a missing layout, or a chat state
    // the store does not know) the pull answers a null nextPullInMs, and with ready chats whose
    // messages have a status it does not know it answers nothing again and again.
    private async pullDue(label: string, limit: number): Promise<OutboxPullResult> {
        for (let emptyPullCount = 0; emptyPullCount < MAX_EMPTY_PULLS_IN_A_ROW; emptyPullCount++) {
            const pullResult = await this.measure(label, () => this.store.pull(limit, WORKER));

            if (pullResult.messages.length > 0) {
                return pullResult;
            }

            if (pullResult.nextPullInMs === null) {
                break;
            }

            await sleep(pullResult.nextPullInMs);
        }

        throw new RuntimeError(
            "No message to pull: fill a layout (make load-fill-pending) with the values of OutboxStatus and OutboxChatState",
        );
    }

    // The call of every OUTBOX_MAINTENANCE_LEASE_RECOVERY_INTERVAL finds no lease as a rule, and the
    // one after a node died finds the chats it held: a batch is pulled and left until its lease
    // expires. Its messages are then marked done, not retried as OutboxLeaseRecovery would, so that
    // the cleanup that follows sees the chats as the pulls leave them.
    private async measureLeaseRecovery(): Promise<void> {
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        await sleep(this.batchIdleMs());
        const abandonedPull = await this.pullDue(`pull(${this.commonLimit.number}), left to expire`, this.commonLimit.number);
        await sleep(this.leaseDurationMs + LEASE_EXPIRY_MARGIN_MS);
        await this.measure("findExpiredLeases()", () => this.store.findExpiredLeases());

        for (const message of abandonedPull.messages) {
            await this.store.markAsDone(message, RESPONSE);
        }
    }

    // The completions of a send that fails: a retry, then a failure that lets the chat go on. Their
    // pulls are printed under labels of their own: they are the pulls of measurePulls().
    private async measureFailures(): Promise<void> {
        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const message = await this.pullOne("retry()");

            await this.measure("retry()", () => this.store.retry(message, UNDELIVERABLE_ERROR, RETRY_DELAY_MS));
        }

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const message = await this.pullOne("markAsFailed()");

            await this.measure("markAsFailed()", () => this.store.markAsFailed(message, UNDELIVERABLE_ERROR));
        }
    }

    private async pullOne(purpose: string): Promise<PulledOutboxMessage> {
        const pullResult = await this.pullDue(`pull(${RUNNER_PULL_LIMIT}), for ${purpose}`, RUNNER_PULL_LIMIT);

        return pullResult.messages[0]!;
    }

    // The poll of the waiter asks for every message a caller on the node waits for: here the messages
    // of one batch, done by the time of the read.
    private async measureFinishedReads(batches: PulledOutboxMessage[][]): Promise<void> {
        for (const batch of batches) {
            const messageIds = batch.map((message) => message.id);

            await this.measure(`find() of ${messageIds.length} messages`, () => this.finishedMessageReader.find(messageIds));
        }
    }

    // The transformer pushes a call of the bot one at a time, the bulk command a batch. Each message
    // goes to a chat of the history, so most of them have no row in the chats table and the push
    // inserts it, as for a user who comes back after the cleanup removed their idle chat.
    private async measurePushes(): Promise<void> {
        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const message = this.nextPushedMessage(OutboxPriority.Call);

            await this.measure("push()", () => this.store.push(message));
        }

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            const messages = Array.from({ length: PUSH_BATCH_MESSAGE_COUNT }, () => this.nextPushedMessage(OutboxPriority.Bulk));

            await this.measure(`pushBatch() of ${PUSH_BATCH_MESSAGE_COUNT}`, () => this.store.pushBatch(messages));
        }
    }

    private nextPushedMessage(priority: OutboxPriority): OutboxMessageInput {
        this.pushNumber++;
        const chatId = 1 + ((this.pushNumber * PUSHED_CHAT_STEP) % HISTORY_CHAT_COUNT);
        const payload = { chat_id: chatId, text: `Font ${this.pushNumber} is converted: woff2 and ttf are attached below.` };

        return { chatId: chatId, method: PUSHED_METHOD, payload: serialize(PUSHED_METHOD, payload), priority: priority };
    }

    private async measurePauses(): Promise<void> {
        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            await this.measure("pause()", () => this.store.pause(PAUSE_DURATION_MS));
        }
    }

    // The calls of OutboxMaintenance: the status line and the count of the blocked chats on their
    // intervals, and the cleanup, where a full batch is followed by another call, down to the call
    // that deletes nothing.
    private async measureMaintenance(): Promise<void> {
        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            await this.measure("readBacklog()", () => this.store.readBacklog());
        }

        for (let callNumber = 1; callNumber <= CALLS_PER_METHOD; callNumber++) {
            await this.measure("countBlockedChats()", () => this.store.countBlockedChats());
        }

        for (;;) {
            const deletedCount = await this.measure("deleteFinishedMessages()", () => this.store.deleteFinishedMessages());

            if (deletedCount === 0) {
                break;
            }
        }

        await this.measure("deleteIdleChats()", () => this.store.deleteIdleChats());
    }

    // Each unblock takes the chat the run has just blocked: its failed message is the newest of the
    // chat, as after a failure in production. The blocked chats of the layout are left to
    // countBlockedChats().
    private async measureUnblocking(): Promise<void> {
        for (let chatNumber = 1; chatNumber <= UNBLOCKED_CHAT_COUNT; chatNumber++) {
            const message = await this.pullOne("markAsFailedAndBlockChat()");

            await this.measure("markAsFailedAndBlockChat()", () => this.store.markAsFailedAndBlockChat(message, UNEXPECTED_ERROR));

            // The message unblocked is returned, not a count, so it is left out of the output.
            if (chatNumber % 2 === 1) {
                await this.measure("retryBlockedChat()", async () => {
                    await this.store.retryBlockedChat(message.chatId);
                });
            } else {
                await this.measure("skipBlockedChat()", async () => {
                    await this.store.skipBlockedChat(message.chatId);
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
        // A count of deleted rows or of blocked chats, or the id of a pushed message.
        if (typeof returned === "number") {
            return `, returned ${returned}`;
        }

        if (typeof returned === "boolean") {
            return `, ${returned}`;
        }

        if (Array.isArray(returned)) {
            return `, ${returned.length} items`;
        }

        if (typeof returned !== "object" || returned === null) {
            return "";
        }

        if ("messages" in returned) {
            const { messages, nextPullInMs } = returned as OutboxPullResult;

            return `, ${messages.length} messages, nextPullInMs ${nextPullInMs}`;
        }

        // The backlog of readBacklog().
        return `, ${JSON.stringify(returned)}`;
    }
}

// A rejection ends the process with its stack and a non-zero code, so nothing is caught here.
void OutboxLoadTest.main();
