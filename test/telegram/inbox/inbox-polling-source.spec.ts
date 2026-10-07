import { expect } from "chai";
import type { Api } from "grammy";
import { HttpError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { sleep } from "app/shared/utils";
import { ALLOWED_UPDATES } from "app/telegram/bot/bot.types";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import type { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import { InboxPollingSource } from "app/telegram/inbox/inbox-polling-source";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import { InboxPushFailed, InboxUpdateRefused } from "app/telegram/inbox/store/inbox-store.errors";
import type { InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { telegramError } from "test/telegram/telegram-bot-api-failure-classifier.helper";
import { NUL_TEXT } from "test/telegram/inbox/inbox-store.helper";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;
const USER = 5_000_000_001;
const OTHER_USER = 5_000_000_002;
const CHAT = 5_000_000_001;
// random() of 0 takes the lower end of the step, half of it: 500 ms after the first failure in a
// row, 1 s after the second, 2 s after the third.
const RETRY_DELAY = new RetryDelay({ firstDelayMs: 1_000, maxDelayMs: 60_000, multiplier: 2 }, () => 0);
// A pause long enough for a spec to see the source wait in it, never waited out.
const LONG_RETRY_DELAY = new RetryDelay({ firstDelayMs: 120_000, maxDelayMs: 120_000, multiplier: 1 }, () => 0);
// How long a spec gives the source to take a step it must not take.
const SETTLE_MS = 20;

type GetUpdatesParams = { offset: number; limit: number; timeout: number; allowed_updates: readonly string[] };

// Stands for the Api of the source. getUpdates gives the answers queued, an update list or an error,
// and once they run out polls until the signal aborts it, as a long poll with no update does.
class FakeApi {
    public readonly calls: string[] = [];
    public readonly getUpdatesCalls: Array<{ params: GetUpdatesParams; signal: AbortSignal }> = [];
    public readonly answers: Array<Update[] | Error> = [];
    // Thrown by the next deleteWebhook calls, one per call.
    public readonly deleteWebhookErrors: Error[] = [];

    public async deleteWebhook(_other: object, _signal: AbortSignal): Promise<true> {
        this.calls.push("deleteWebhook");

        const error = this.deleteWebhookErrors.shift();

        if (error !== undefined) {
            throw error;
        }

        return true;
    }

    public async getMe(_signal: AbortSignal): Promise<UserFromGetMe> {
        this.calls.push("getMe");

        return ME;
    }

    public async getUpdates(params: GetUpdatesParams, signal: AbortSignal): Promise<Update[]> {
        this.calls.push("getUpdates");
        this.getUpdatesCalls.push({ params: params, signal: signal });

        const answer = this.answers.shift();

        if (answer === undefined) {
            return await this.pollUntilAborted(signal);
        }

        if (answer instanceof Error) {
            throw answer;
        }

        return answer;
    }

    public async waitForGetUpdates(count: number): Promise<void> {
        while (this.getUpdatesCalls.length < count) {
            await sleep(1);
        }
    }

    public offsets(): number[] {
        return this.getUpdatesCalls.map((call) => call.params.offset);
    }

    private pollUntilAborted(signal: AbortSignal): Promise<never> {
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new HttpError("Network request for 'getUpdates' failed!", signal.reason)));
        });
    }
}

// Stands for InboxStore: it refuses a push with a NUL character in an update, the whole batch with
// it, and fails a call by the failures queued.
class FakeStore {
    public readonly calls: Array<{ method: "pushBatch" | "push"; updateIds: number[] }> = [];
    public readonly stored: InboxUpdateInput[] = [];
    // The refusals it threw, in order.
    public readonly refusals: InboxUpdateRefused[] = [];
    // Thrown by the next calls, one per call; undefined lets its call through.
    public readonly failures: Array<Error | undefined> = [];
    // Holds every call until it settles.
    public hold: Promise<void> = Promise.resolve();

    public async pushBatch(inputs: InboxUpdateInput[]): Promise<void> {
        await this.write("pushBatch", inputs);
    }

    public async push(input: InboxUpdateInput): Promise<void> {
        await this.write("push", [input]);
    }

    public async waitForCalls(count: number): Promise<void> {
        while (this.calls.length < count) {
            await sleep(1);
        }
    }

    public storedUpdateIds(): number[] {
        return this.stored.map((input) => input.update.update_id);
    }

    private async write(method: "pushBatch" | "push", inputs: InboxUpdateInput[]): Promise<void> {
        this.calls.push({ method: method, updateIds: inputs.map((input) => input.update.update_id) });

        await this.hold;

        const failure = this.failures.shift();

        if (failure !== undefined) {
            throw failure;
        }

        if (inputs.some((input) => input.update.message?.text === NUL_TEXT)) {
            const refusal = new InboxUpdateRefused("unsupported Unicode escape sequence", { code: "22P05" });
            this.refusals.push(refusal);

            throw refusal;
        }

        this.stored.push(...inputs);
    }
}

// Records the pause after a failure instead of waiting it out.
class RecordingPollingSource extends InboxPollingSource {
    public readonly pauses: number[] = [];

    protected override async pause(durationMs: number): Promise<void> {
        this.pauses.push(durationMs);
    }
}

describe("InboxPollingSource", function () {
    let api: FakeApi;
    let store: FakeStore;
    let logger: RecordingLogger;
    // The timeout the source asked the factory to make its Api with.
    let apiTimeoutSeconds: number | undefined;
    let source: RecordingPollingSource;
    // A source that waits its pauses out, for the specs of the pause itself.
    let waitingSource: InboxPollingSource | undefined;

    beforeEach(function () {
        api = new FakeApi();
        store = new FakeStore();
        logger = new RecordingLogger();
        apiTimeoutSeconds = undefined;
        source = new RecordingPollingSource(...sourceDependencies(RETRY_DELAY));
        waitingSource = undefined;
    });

    afterEach(async function () {
        await source.stop();
        await waitingSource?.stop();
    });

    function sourceDependencies(retryDelay: RetryDelay): ConstructorParameters<typeof InboxPollingSource> {
        const apiFactory = {
            create: (timeoutSeconds: number): Api => {
                apiTimeoutSeconds = timeoutSeconds;

                return api as unknown as Api;
            },
        };

        return [
            store as unknown as InboxStore,
            apiFactory as unknown as TelegramApiFactory,
            retryDelay,
            new TelegramBotApiFailureClassifier(),
            logger,
        ];
    }

    function startWaitingSource(): InboxPollingSource {
        waitingSource = new InboxPollingSource(...sourceDependencies(LONG_RETRY_DELAY));
        waitingSource.start();

        return waitingSource;
    }

    describe("polling", function () {
        it("deletes the webhook, then long-polls with the update types of the bot from below every update_id", async function () {
            source.start();
            await api.waitForGetUpdates(1);

            expect(api.calls).to.deep.equal(["deleteWebhook", "getMe", "getUpdates"]);
            expect(api.getUpdatesCalls[0]?.params).to.deep.equal({ offset: 0, limit: 100, timeout: 30, allowed_updates: ALLOWED_UPDATES });
        });

        // The list is ALLOWED_UPDATES in bot.types.ts: without it getUpdates would drag in every type the
        // bot does not serve.
        it("polls only messages", async function () {
            source.start();
            await api.waitForGetUpdates(1);

            expect(api.getUpdatesCalls[0]?.params.allowed_updates).to.deep.equal(["message"]);
        });

        it("makes its Api with a timeout that outlasts the long poll", function () {
            expect(apiTimeoutSeconds).to.equal(40);
        });

        it("refuses a second start", function () {
            source.start();

            expect(() => source.start()).to.throw("Inbox polling source is already started!");
        });

        it("tries the preparation again after a failure, and polls once it goes through", async function () {
            api.deleteWebhookErrors.push(new Error("deleteWebhook failed"));

            source.start();
            await api.waitForGetUpdates(1);

            expect(api.calls).to.deep.equal(["deleteWebhook", "deleteWebhook", "getMe", "getUpdates"]);
            expect(logger.errors.map((record) => record.message)).to.deep.equal(["Preparing the polling failed, the source tries again."]);
        });

        it("pushes the updates of one getUpdates in one batch, each with its user and chat", async function () {
            api.answers.push([message(10, USER), message(11, OTHER_USER)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([{ method: "pushBatch", updateIds: [10, 11] }]);
            expect(store.stored.map((input) => [input.userId, input.chatId])).to.deep.equal([
                [USER, CHAT],
                [OTHER_USER, CHAT],
            ]);
            expect(store.stored[0]?.update).to.deep.equal(message(10, USER));
        });

        it("moves the offset past the last update once the batch is stored, and keeps it over an empty answer", async function () {
            api.answers.push([message(10), message(11)], [], [message(12)]);

            source.start();
            await api.waitForGetUpdates(4);

            expect(api.offsets()).to.deep.equal([0, 12, 12, 13]);
        });

        // A callback query comes from the user who pressed the button, on a message the bot sent.
        it("takes the group from the user and the chat grammY reads off the update, as the session key does", async function () {
            api.answers.push([callbackQuery(10, OTHER_USER)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.stored.map((input) => [input.userId, input.chatId])).to.deep.equal([[OTHER_USER, CHAT]]);
        });

        // A channel post has a chat but no user.
        it("names in the warning which half of the session key an update lacks", async function () {
            const channelPost = {
                update_id: 10,
                channel_post: { message_id: 1, date: 0, chat: { id: CHAT, type: "channel", title: "Channel" }, text: "text" },
            } as Update;
            api.answers.push([channelPost]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(logger.warnings.map((record) => record.payload)).to.deep.equal([{ updateId: 10, hasFrom: false, hasChat: true }]);
        });

        it("drops an update without a user or a chat with a warning and stores the rest", async function () {
            const withoutUser = { update_id: 11, poll: { id: "1" } } as unknown as Update;
            api.answers.push([message(10), withoutUser, message(12)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.storedUpdateIds()).to.deep.equal([10, 12]);
            expect(api.offsets()).to.deep.equal([0, 13]);
            expect(logger.warnings).to.deep.equal([
                {
                    message: "Update is dropped, because its session key cannot be resolved.",
                    payload: { updateId: 11, hasFrom: false, hasChat: false },
                },
            ]);
        });
    });

    describe("a failure", function () {
        it("gets the updates again from the same offset after a failed getUpdates, and logs the error", async function () {
            const failure = new HttpError("Network request for 'getUpdates' failed!", new Error("socket hang up"));
            api.answers.push([message(10)], failure, [message(11)]);

            source.start();
            await api.waitForGetUpdates(4);

            expect(api.offsets()).to.deep.equal([0, 11, 11, 12]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Getting updates failed, the source tries again from the same offset.",
                    payload: { offset: 11, cause: failure },
                },
            ]);
        });

        it("does not move the offset over a batch that failed to store, and stores it on the next getUpdates", async function () {
            const failure = new Error("write CONNECTION_CLOSED pgsql:5432");
            store.failures.push(failure);
            api.answers.push([message(10), message(11)], [message(10), message(11)]);

            source.start();
            await api.waitForGetUpdates(3);

            expect(api.offsets()).to.deep.equal([0, 0, 12]);
            expect(store.calls.map((call) => call.method)).to.deep.equal(["pushBatch", "pushBatch"]);
            expect(store.storedUpdateIds()).to.deep.equal([10, 11]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Storing updates failed, the source gets them again from the same offset.",
                    payload: { updateIds: [10, 11], cause: failure },
                },
            ]);
        });

        it("pushes a refused batch one update at a time, drops the refused update with an error and moves on", async function () {
            api.answers.push([message(10), message(11, USER, NUL_TEXT), message(12)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([
                { method: "pushBatch", updateIds: [10, 11, 12] },
                { method: "push", updateIds: [10] },
                { method: "push", updateIds: [11] },
                { method: "push", updateIds: [12] },
            ]);
            expect(store.storedUpdateIds()).to.deep.equal([10, 12]);
            expect(api.offsets()).to.deep.equal([0, 13]);
            // The refusal of the single push of update 11, the one after the refusal of the batch.
            expect(logger.errors).to.deep.equal([
                { message: "The inbox refused an update, it is dropped.", payload: { updateId: 11, cause: store.refusals[1] } },
            ]);
        });

        it("does not move the offset when a push of one update fails for another reason, and logs the updates not stored", async function () {
            const failure = new Error("write CONNECTION_CLOSED pgsql:5432");
            api.answers.push([message(10), message(11), message(12, USER, NUL_TEXT)]);
            // The batch is refused for update 12, update 10 goes in alone, then the push of update 11
            // fails on the connection.
            store.failures.push(undefined, undefined, failure);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([
                { method: "pushBatch", updateIds: [10, 11, 12] },
                { method: "push", updateIds: [10] },
                { method: "push", updateIds: [11] },
            ]);
            expect(api.offsets()).to.deep.equal([0, 0]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Storing updates failed, the source gets them again from the same offset.",
                    payload: { updateIds: [11, 12], cause: failure },
                },
            ]);
        });

        it("does not take a push failed for another reason for a refusal", async function () {
            const failure = new InboxPushFailed('invalid input syntax for type bigint: "x"', { code: "22P02" });
            store.failures.push(failure);
            api.answers.push([message(10)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([{ method: "pushBatch", updateIds: [10] }]);
            expect(api.offsets()).to.deep.equal([0, 0]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Storing updates failed, the source gets them again from the same offset.",
                    payload: { updateIds: [10], cause: failure },
                },
            ]);
        });

        it("stops the polling on an unexpected error with a critical log", async function () {
            const failure = new Error("the logger failed");
            logger.warning = (): void => {
                throw failure;
            };
            api.answers.push([{ update_id: 10 } as Update]);

            source.start();
            await api.waitForGetUpdates(1);
            await source.stop();

            expect(logger.criticals).to.deep.equal([
                { message: "The inbox polling stopped on an unexpected error.", payload: { cause: failure } },
            ]);
            expect(api.getUpdatesCalls).to.have.lengthOf(1);
        });
    });

    describe("the pause after a failure", function () {
        it("grows with the failures in a row, of calls and inserts alike, by the retry delay", async function () {
            api.deleteWebhookErrors.push(new Error("deleteWebhook failed"));
            store.failures.push(new Error("write CONNECTION_CLOSED pgsql:5432"));
            api.answers.push(new Error("getUpdates failed"), [message(10)], new Error("getUpdates failed"), [message(10)]);

            source.start();
            await api.waitForGetUpdates(5);

            // The preparation went through and reset the count; the store failure and the second
            // getUpdates failure come in a row.
            expect(source.pauses).to.deep.equal([500, 500, 1_000, 2_000]);
        });

        it("starts over after a stored batch", async function () {
            api.answers.push(new Error("getUpdates failed"), [message(10)], new Error("getUpdates failed"));

            source.start();
            await api.waitForGetUpdates(4);

            expect(source.pauses).to.deep.equal([500, 500]);
        });

        it("waits as long as a 429 asks when that is longer than the retry delay", async function () {
            api.answers.push(telegramError(429, "Too Many Requests: retry after 5", { retry_after: 5 }));

            source.start();
            await api.waitForGetUpdates(2);

            expect(source.pauses).to.deep.equal([5_000]);
        });

        it("caps the wait of a 429 at the longest delay of a Node timer", async function () {
            api.answers.push(telegramError(429, "Too Many Requests: retry after 3000000", { retry_after: 3_000_000 }));

            source.start();
            await api.waitForGetUpdates(2);

            expect(source.pauses).to.deep.equal([2 ** 31 - 1]);
        });

        // A 429 comes from Telegram: the Bot API classifier has no say over a failure of the store.
        it("waits the retry delay alone after a failed push, whatever the failure looks like", async function () {
            store.failures.push(telegramError(429, "Too Many Requests: retry after 5", { retry_after: 5 }));
            api.answers.push([message(10)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(source.pauses).to.deep.equal([500]);
        });

        it("keeps the retry delay when a 429 asks for less", async function () {
            api.answers.push(
                new Error("getUpdates failed"),
                new Error("getUpdates failed"),
                telegramError(429, "Too Many Requests: retry after 1", { retry_after: 1 }),
            );

            source.start();
            await api.waitForGetUpdates(4);

            expect(source.pauses).to.deep.equal([500, 1_000, 2_000]);
        });

        it("waits the pause out before it calls again", async function () {
            api.answers.push(new Error("getUpdates failed"));

            startWaitingSource();
            await api.waitForGetUpdates(1);
            await sleep(SETTLE_MS);

            expect(api.getUpdatesCalls).to.have.lengthOf(1);
        });
    });

    describe("stop", function () {
        it("aborts the getUpdates in flight, makes no call after it and logs no failure", async function () {
            source.start();
            await api.waitForGetUpdates(1);

            await source.stop();
            await sleep(SETTLE_MS);

            expect(api.getUpdatesCalls).to.have.lengthOf(1);
            expect(api.getUpdatesCalls[0]?.signal.aborted).to.equal(true);
            expect(logger.errors).to.deep.equal([]);
        });

        it("resolves only once the insert in flight has stored its updates", async function () {
            const { promise, resolve } = Promise.withResolvers<void>();
            store.hold = promise;
            api.answers.push([message(10)]);

            source.start();
            await store.waitForCalls(1);

            let isStopped = false;
            const stopped = source.stop().then(() => {
                isStopped = true;
            });
            await sleep(SETTLE_MS);

            expect(isStopped).to.equal(false);

            resolve();
            await stopped;

            expect(store.storedUpdateIds()).to.deep.equal([10]);
            expect(api.getUpdatesCalls).to.have.lengthOf(1);
        });

        it("does not go on with the single pushes of a refused batch after the stop", async function () {
            const { promise, resolve } = Promise.withResolvers<void>();
            store.hold = promise;
            api.answers.push([message(10), message(11, USER, NUL_TEXT), message(12)]);

            source.start();
            await store.waitForCalls(1);
            const stopped = source.stop();
            resolve();
            await stopped;

            expect(store.calls.map((call) => call.method)).to.deep.equal(["pushBatch"]);
            expect(store.stored).to.deep.equal([]);
        });

        it("logs a push that fails after the stop as a warning, with no retry promised", async function () {
            const failure = new Error("write CONNECTION_CLOSED pgsql:5432");
            const { promise, resolve } = Promise.withResolvers<void>();
            store.hold = promise;
            store.failures.push(failure);
            api.answers.push([message(10)]);

            source.start();
            await store.waitForCalls(1);
            const stopped = source.stop();
            resolve();
            await stopped;

            expect(logger.errors).to.deep.equal([]);
            expect(logger.warnings).to.deep.equal([
                {
                    message: "Storing updates failed after the stop, the next start gets them again.",
                    payload: { updateIds: [10], cause: failure },
                },
            ]);
        });

        it("cuts the pause after a failure short", async function () {
            api.answers.push(new Error("getUpdates failed"));

            const pausing = startWaitingSource();
            await api.waitForGetUpdates(1);
            await pausing.stop();

            expect(api.getUpdatesCalls).to.have.lengthOf(1);
        });

        it("stops a preparation that keeps failing without polling", async function () {
            api.deleteWebhookErrors.push(new Error("deleteWebhook failed"));

            const pausing = startWaitingSource();
            await sleep(SETTLE_MS);
            await pausing.stop();

            expect(api.calls).to.deep.equal(["deleteWebhook"]);
        });

        it("makes no call when stopped before the start", async function () {
            await source.stop();
            source.start();
            await source.stop();

            expect(api.calls).to.deep.equal([]);
        });
    });
});

// A private message of the user.
function message(updateId: number, userId = USER, text = "text"): Update {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 0,
            chat: { id: CHAT, type: "private", first_name: "User" },
            from: { id: userId, is_bot: false, first_name: "User" },
            text: text,
        },
    };
}

// The user pressed a button on a message the bot sent to the chat.
function callbackQuery(updateId: number, userId: number): Update {
    return {
        update_id: updateId,
        callback_query: {
            id: String(updateId),
            chat_instance: "1",
            from: { id: userId, is_bot: false, first_name: "User" },
            message: {
                message_id: updateId,
                date: 0,
                chat: { id: CHAT, type: "private", first_name: "User" },
                from: { id: ME.id, is_bot: true, first_name: ME.first_name },
                text: "text",
            },
        },
    };
}
