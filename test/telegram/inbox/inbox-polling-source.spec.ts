import { expect } from "chai";
import type { Api } from "grammy";
import { HttpError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import postgres from "postgres";
import { sleep } from "app/shared/utils";
import { ALLOWED_UPDATES } from "app/telegram/bot/bot";
import { InboxPollingSource } from "app/telegram/inbox/inbox-polling-source";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";

const TOKEN = "123456789:secret";
const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;
const USER = 5_000_000_001;
const OTHER_USER = 5_000_000_002;
const CHAT = 5_000_000_001;
// Long enough for a spec to see the source wait in it, never waited out.
const LONG_PAUSE_MS = 60_000;
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

// Stands for InboxStore: it refuses an update as PostgreSQL refuses a value of jsonb, the whole batch
// with it, and fails a call by the failures queued.
class FakeStore {
    public readonly calls: Array<{ method: "pushBatch" | "push"; updateIds: number[] }> = [];
    public readonly stored: InboxUpdateInput[] = [];
    public readonly refusedUpdateIds = new Set<number>();
    // Thrown by the next calls, one per call.
    public readonly failures: Error[] = [];
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

        if (inputs.some((input) => this.refusedUpdateIds.has(input.update.update_id))) {
            throw postgresError("22P05");
        }

        this.stored.push(...inputs);
    }
}

describe("InboxPollingSource", function () {
    let api: FakeApi;
    let store: FakeStore;
    let logger: RecordingLogger;
    let source: InboxPollingSource;

    beforeEach(function () {
        api = new FakeApi();
        store = new FakeStore();
        logger = new RecordingLogger();
        source = createSource(0);
    });

    afterEach(async function () {
        await source.stop();
    });

    function createSource(retryPauseMs: number): InboxPollingSource {
        return new InboxPollingSource(
            store as unknown as InboxStore,
            new OutboxErrorSerializer(TOKEN),
            logger,
            api as unknown as Api,
            retryPauseMs,
        );
    }

    describe("polling", function () {
        it("deletes the webhook, then long-polls with the update types of the bot from below every update_id", async function () {
            source.start();
            await api.waitForGetUpdates(1);

            expect(api.calls).to.deep.equal(["deleteWebhook", "getMe", "getUpdates"]);
            expect(api.getUpdatesCalls[0]?.params).to.deep.equal({ offset: 0, limit: 100, timeout: 30, allowed_updates: ALLOWED_UPDATES });
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

        it("drops an update without a user or a chat with a warning and stores the rest", async function () {
            const withoutUser = { update_id: 11, poll: { id: "1" } } as unknown as Update;
            api.answers.push([message(10), withoutUser, message(12)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.storedUpdateIds()).to.deep.equal([10, 12]);
            expect(api.offsets()).to.deep.equal([0, 13]);
            expect(logger.warnings).to.deep.equal([
                { message: "Update is dropped, because its session key cannot be resolved.", payload: { updateId: 11 } },
            ]);
        });
    });

    describe("a failure", function () {
        it("gets the updates again from the same offset after a failed getUpdates, and logs it without the bot token", async function () {
            const fetchError = new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: socket hang up`);
            api.answers.push([message(10)], new HttpError("Network request for 'getUpdates' failed!", fetchError), [message(11)]);

            source.start();
            await api.waitForGetUpdates(4);

            expect(api.offsets()).to.deep.equal([0, 11, 11, 12]);
            expect(logger.errors).to.have.lengthOf(1);
            expect(logger.errors[0]?.message).to.equal("Getting updates failed, the source tries again from the same offset.");
            expect(logger.errors[0]?.payload?.["offset"]).to.equal(11);
            expect(JSON.stringify(logger.errors[0]?.payload)).to.include("socket hang up").and.not.include(TOKEN);
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
            store.refusedUpdateIds.add(11);
            api.answers.push([message(10), message(11), message(12)]);

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
            expect(logger.errors).to.have.lengthOf(1);
            expect(logger.errors[0]?.message).to.equal("The inbox refused an update, it is dropped.");
            expect(logger.errors[0]?.payload?.["updateId"]).to.equal(11);
            expect(logger.errors[0]?.payload?.["cause"]).to.be.instanceOf(postgres.PostgresError);
        });

        it("does not move the offset when a push of one update fails for another reason than a refusal", async function () {
            const failure = new Error("write CONNECTION_CLOSED pgsql:5432");
            api.answers.push([message(10), message(11)]);
            // The batch is refused, then the single push of update 10 fails on the connection.
            store.failures.push(postgresError("22P05"), failure);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([
                { method: "pushBatch", updateIds: [10, 11] },
                { method: "push", updateIds: [10] },
            ]);
            expect(api.offsets()).to.deep.equal([0, 0]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Storing updates failed, the source gets them again from the same offset.",
                    payload: { updateIds: [10, 11], cause: failure },
                },
            ]);
        });

        it("takes only a data exception for a refusal: a batch failed by another SQLSTATE is not pushed one at a time", async function () {
            store.failures.push(postgresError("40P01"));
            api.answers.push([message(10)]);

            source.start();
            await api.waitForGetUpdates(2);

            expect(store.calls).to.deep.equal([{ method: "pushBatch", updateIds: [10] }]);
            expect(api.offsets()).to.deep.equal([0, 0]);
        });

        it("waits the pause out before it calls again", async function () {
            await source.stop();
            source = createSource(LONG_PAUSE_MS);
            api.answers.push(new Error("getUpdates failed"));

            source.start();
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

        it("cuts the pause after a failure short", async function () {
            await source.stop();
            source = createSource(LONG_PAUSE_MS);
            api.answers.push(new Error("getUpdates failed"));

            source.start();
            await api.waitForGetUpdates(1);
            await source.stop();

            expect(api.getUpdatesCalls).to.have.lengthOf(1);
        });

        it("stops a preparation that keeps failing without polling", async function () {
            await source.stop();
            source = createSource(LONG_PAUSE_MS);
            api.deleteWebhookErrors.push(new Error("deleteWebhook failed"));

            source.start();
            await sleep(SETTLE_MS);
            await source.stop();

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
function message(updateId: number, userId = USER): Update {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: 0,
            chat: { id: CHAT, type: "private", first_name: "User" },
            from: { id: userId, is_bot: false, first_name: "User" },
            text: "text",
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

// postgres.js builds the error from the fields of the server's answer, a constructor its typings do
// not declare.
function postgresError(code: string): Error {
    const PostgresError = postgres.PostgresError as unknown as new (fields: { message: string; code: string }) => Error;

    return new PostgresError({ message: `SQLSTATE ${code}`, code: code });
}
