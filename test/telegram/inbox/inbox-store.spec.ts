import "reflect-metadata";
import { expect } from "chai";
import type { Update } from "grammy/types";
import { Database } from "app/platform/database/database";
import type { DatabaseSettings } from "app/platform/database/database.types";
import { MS_PER_DAY, MS_PER_SECOND } from "app/shared/time";
import { sleep } from "app/shared/utils";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import type { TransactionSql } from "postgres";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type {
    ClaimedInboxUpdate,
    ExpiredInboxLease,
    InboxAttempt,
    InboxAttemptError,
    InboxCleanupSettings,
    InboxLease,
    InboxUpdateInput,
    InboxWorker,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxChannel, InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import {
    InboxGroupNotBlocked,
    InboxPushFailed,
    InboxUpdateNotLeased,
    InboxUpdateRefused,
    InvalidClaimLimit,
} from "app/telegram/inbox/store/inbox-store.errors";
import { listenTo, rollingBackDatabase, SPEC_ROLLBACK_MESSAGE, testDatabaseSettings, waitForLockWaiters } from "test/database.helper";
import { RecordingLogger } from "test/platform/logger/recording-logger.helper";
import { messageInput, NUL_TEXT, SURROGATE_TEXT } from "test/telegram/inbox/inbox-store.helper";
import { waitUntil } from "test/shared/utils.helper";

const USER = 5_000_000_001;
const OTHER_USER = 5_000_000_002;
const CHAT = 5_000_000_001;
const GROUP_CHAT = -1_001_234_567_890;
// A user id past the range of bigint.
const BEYOND_BIGINT = 1e20;
// Longer than any wait of a passing run, shorter than SPEC_TIMEOUT_MS: a hung wait fails with its
// own message and stops before after() closes the clients.
const WAIT_DEADLINE_MS = 5_000;
// The default timeout of mocha, 2 s, is shorter than the deadline and would fail a hung wait first.
const SPEC_TIMEOUT_MS = 10_000;
// The spec of two claimers drains 48 updates through two clients, beyond SPEC_TIMEOUT_MS on a slow
// machine.
const CONCURRENT_CLAIMS_TIMEOUT_MS = 20_000;
const LEASE_DURATION_MS = 600_000;
// A lease that passes before the spec reads it, after a sleep of twice as long.
const SHORT_LEASE_MS = 10;
// A lease that outlasts its extension made right after the claim, on a loaded machine too, and
// passes during a sleep of twice as long.
const BRIEF_LEASE_MS = 500;
// A retry delay no spec waits out.
const LONG_RETRY_DELAY_MS = 60_000;
// How far the delay read back may fall short of the one written: the time between the two statements.
const ELAPSED_TOLERANCE_MS = 1_000;
// A token no claim gave out.
const OTHER_TOKEN = "00000000-0000-4000-8000-000000000000";
const CLEANUP: InboxCleanupSettings = { doneRetentionMs: MS_PER_DAY, skippedRetentionMs: 2 * MS_PER_DAY, batchSize: 10 };
const WORKER: InboxWorker = { host: "node-1", pid: 101, workerId: "worker-1" };
const TRANSIENT: InboxAttemptError = { kind: InboxFailureKind.Transient, message: "write CONNECTION_CLOSED pgsql:5432" };
const UNDELIVERABLE: InboxAttemptError = { kind: InboxFailureKind.Undeliverable, message: "Forbidden: bot was blocked by the user" };
const UNEXPECTED: InboxAttemptError = { kind: InboxFailureKind.Unexpected, message: "Cannot read properties of undefined" };
const EXPIRED_LEASE_ERROR: InboxAttemptError = { kind: InboxFailureKind.Transient, message: "The lease of the group passed" };

type GroupRow = { state: string };
describe("InboxStore", function () {
    this.timeout(SPEC_TIMEOUT_MS);

    let settings: DatabaseSettings;
    let database: Database;
    // A second postgres() client: a claimer on another node, or a transaction held open.
    let other: Database;
    // The client of waitForLockWaiters(): store calls waiting for a lock hold connections of
    // database, and a poll through the same pool could queue behind them.
    let observer: Database;
    let logger: RecordingLogger;
    let store: InboxStore;

    before(async function () {
        settings = await testDatabaseSettings();

        database = new Database(settings, false);
        other = new Database(settings, false);
        observer = new Database(settings, false);
    });

    beforeEach(async function () {
        logger = new RecordingLogger();
        store = new InboxStore(database, logger, LEASE_DURATION_MS, CLEANUP);
        await database.sql`TRUNCATE telegram_inbox, telegram_inbox_groups`;
    });

    after(async function () {
        // A failed before does not get to assign the clients, and a failure in after would hide its cause.
        await database?.close();
        await other?.close();
        await observer?.close();
    });

    describe("push", function () {
        it("keeps the group and the update of a claimed update as they were pushed", async function () {
            const pushed = input(10, USER, GROUP_CHAT);

            await store.push(pushed);

            const [claimed] = await store.claim(10, WORKER);

            expect(claimed).to.deep.include({ updateId: 10, userId: USER, chatId: GROUP_CHAT, update: pushed.update });
        });

        it("does not insert an update whose update_id is stored already, and keeps the first one", async function () {
            await store.push(input(10, USER, CHAT, "first"));
            await store.push(input(10, USER, CHAT, "redelivered"));
            await store.pushBatch([input(10, USER, CHAT, "in a batch"), input(11)]);

            const rows = await database.sql<{ update_id: string; text: string }[]>`
                SELECT update_id, update -> 'message' ->> 'text' AS text
                FROM telegram_inbox
                ORDER BY update_id
            `;

            expect(rows.map((row) => [Number(row.update_id), row.text])).to.deep.equal([
                [10, "first"],
                [11, "text"],
            ]);
        });

        // A poll gets an empty batch more often than not.
        it("does not open a transaction for an empty batch", async function () {
            const unused = { sql: { begin: () => expect.fail("an empty batch opened a transaction") } } as unknown as Database;

            await new InboxStore(unused, logger, LEASE_DURATION_MS, CLEANUP).pushBatch([]);
        });

        it("inserts an update repeated inside one batch once", async function () {
            await store.pushBatch([input(10, USER, CHAT, "first"), input(10, USER, CHAT, "repeated")]);

            expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
        });

        it("leaves an idle group idle when every update of the batch is stored already", async function () {
            await store.push(input(10));
            await store.markAsDone(await claimOne());

            await store.push(input(10));

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
            expect(await store.claim(10, WORKER)).to.deep.equal([]);
        });

        it("makes the group of a new update ready and leaves a blocked group blocked", async function () {
            await store.push(input(10, USER, CHAT));
            await database.sql`UPDATE telegram_inbox_groups SET state = ${InboxGroupState.Blocked}`;

            await store.pushBatch([input(11, USER, CHAT), input(12, OTHER_USER, CHAT)]);

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            expect(await group(OTHER_USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
        });

        // The polling source pushes the rest of a refused batch one at a time and drops the refused
        // update (docs/architecture/inbox.md, "The polling source").
        for (const [name, text, code] of [
            ["a NUL character", NUL_TEXT, "22P05"],
            ["a lone surrogate", SURROGATE_TEXT, "22P02"],
        ] as const) {
            it(`refuses a batch with ${name} in an update by SQLSTATE ${code} and stores none of it`, async function () {
                const thrown = await pushFailure(store, [input(10), input(11, USER, CHAT, text)]);

                expect(thrown).to.be.instanceOf(InboxUpdateRefused);
                expect((thrown as InboxUpdateRefused).payload).to.include({ code: code });
                expect(await statuses()).to.deep.equal([]);
            });

            it(`refuses an update with ${name} in a key deep inside it`, async function () {
                const pushed = input(10);
                const update = { ...pushed.update, nested: [{ ["key" + text]: "value" }] } as Update;

                expect(await pushFailure(store, [{ ...pushed, update: update }])).to.be.instanceOf(InboxUpdateRefused);
            });
        }

        // Not the error as a whole: the CONTEXT PostgreSQL gives a refused value, in its where field,
        // holds the text of the message.
        it("throws a refusal by the code, message and detail of PostgreSQL, without the update", async function () {
            const thrown = await pushFailure(store, [input(10, USER, CHAT, NUL_TEXT)]);

            expect(thrown).to.be.instanceOf(InboxUpdateRefused);
            expect((thrown as InboxUpdateRefused).payload).to.have.all.keys("code", "detail");
            expect((thrown as InboxUpdateRefused).cause).to.equal(undefined);
            expect(JSON.stringify(thrown)).not.to.include("before");
        });

        // 22P02 is the code of any malformed input: a change of the store that broke every row would
        // give it, and the code alone would drop every update.
        it("does not take SQLSTATE 22P02 for a refusal when no update holds a refused value", async function () {
            const pushed = input(10);
            const update = { ...pushed.update, update_id: "not a number" } as unknown as Update;

            const thrown = await pushFailure(store, [{ ...pushed, update: update }]);

            expect(thrown).to.be.instanceOf(InboxPushFailed).and.not.to.be.instanceOf(InboxUpdateRefused);
            expect((thrown as InboxPushFailed).payload).to.include({ code: "22P02" });
        });

        // The groups go in before the updates are cast to jsonb, so a user id past bigint fails first.
        it("does not take another data exception for a refusal, though an update holds a refused value", async function () {
            const thrown = await pushFailure(store, [input(10, BEYOND_BIGINT, CHAT, NUL_TEXT)]);

            expect(thrown).to.be.instanceOf(InboxPushFailed).and.not.to.be.instanceOf(InboxUpdateRefused);
            expect((thrown as InboxPushFailed).payload).to.include({ code: "22003" });
        });

        it("lets a failure that is not an error of PostgreSQL through as it is", async function () {
            const failure = new Error("write CONNECTION_CLOSED pgsql:5432");
            const failing = { sql: { begin: () => Promise.reject(failure) } } as unknown as Database;

            const thrown = await pushFailure(new InboxStore(failing, logger, LEASE_DURATION_MS, CLEANUP), [input(10)]);

            expect(thrown).to.equal(failure);
        });

        async function pushFailure(target: InboxStore, inputs: InboxUpdateInput[]): Promise<unknown> {
            return await target.pushBatch(inputs).then(
                () => expect.fail("pushBatch() was expected to reject"),
                (reason: unknown) => reason,
            );
        }
    });

    describe("claim", function () {
        it("gives out the updates of a group in update_id order, whatever order they were pushed in", async function () {
            await store.push(input(12));
            await store.pushBatch([input(11), input(10)]);

            expect(await drain(store)).to.deep.equal([10, 11, 12]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
        });

        it("never keeps two updates of a group in processing", async function () {
            await store.pushBatch([input(10), input(11), input(12)]);

            expect(await store.claim(10, WORKER)).to.have.lengthOf(1);
            expect(await store.claim(10, WORKER)).to.deep.equal([]);
            expect(await statuses()).to.deep.equal([InboxStatus.Processing, InboxStatus.Pending, InboxStatus.Pending]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
        });

        // The group is the session key: the same user in another chat, and another user in the same
        // chat, are groups of their own.
        it("takes one head from each group in one claim, a group being a user in a chat", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, USER, GROUP_CHAT), input(12, OTHER_USER, GROUP_CHAT), input(13)]);

            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([10, 11, 12]);
        });

        it("claims no more groups than the limit", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);

            expect(await store.claim(1, WORKER)).to.have.lengthOf(1);
        });

        it("serves the groups in turn, not one group drained first", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, USER, CHAT), input(12, USER, CHAT)]);
            await store.pushBatch([input(20, OTHER_USER, CHAT), input(21, OTHER_USER, CHAT), input(22, OTHER_USER, CHAT)]);

            expect(await drain(store)).to.deep.equal([10, 20, 11, 21, 12, 22]);
        });

        // 2 ** 53 is the first integer above Number.MAX_SAFE_INTEGER.
        for (const limit of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
            it(`refuses a claim of ${limit} updates and claims nothing`, async function () {
                await store.push(input(10));

                const error = await store.claim(limit, WORKER).then(
                    () => expect.fail("claim() was expected to reject"),
                    (reason: unknown) => reason,
                );

                expect(error).to.be.instanceOf(InvalidClaimLimit);
                expect((error as InvalidClaimLimit).payload).to.deep.equal({ limit });
                expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
            });
        }

        it("takes a limit beyond a 32-bit integer", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);

            expect(await store.claim(2 ** 31, WORKER)).to.have.lengthOf(2);
        });

        it("skips a group another claimer holds and takes the next one", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);

            await other.sql.begin(async (sql) => {
                await sql`SELECT user_id FROM telegram_inbox_groups WHERE user_id = ${USER} FOR UPDATE`;

                expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
            });
        });

        it("never gives one group to two claimers on separate clients at once", async function () {
            this.timeout(CONCURRENT_CLAIMS_TIMEOUT_MS);

            const users = [USER, OTHER_USER, 1, 2, 3, 4];
            const perGroup = 8;
            const updateIds: number[] = [];
            const inputs: InboxUpdateInput[] = [];

            for (let index = 0; index < perGroup; index++) {
                for (const userId of users) {
                    const updateId = updateIds.length + 1;

                    updateIds.push(updateId);
                    inputs.push(input(updateId, userId, CHAT));
                }
            }

            await store.pushBatch(inputs);

            const claims: number[] = [];
            const claimsByUser = new Map<number, number[]>();
            const inFlight = new Set<number>();
            const deadline = Date.now() + WAIT_DEADLINE_MS;
            let hasFailed = false;

            // A group leaves inFlight before markAsDone commits: the group can be claimed only after
            // the commit, so an overlap seen here is a real one.
            const claim = async (client: InboxStore): Promise<void> => {
                while (!hasFailed && claims.length < updateIds.length) {
                    if (Date.now() > deadline) {
                        expect.fail(`${claims.length} of ${updateIds.length} updates claimed by the deadline`);
                    }

                    const batch = await client.claim(2, WORKER);

                    if (batch.length === 0) {
                        await sleep(1);
                        continue;
                    }

                    for (const claimed of batch) {
                        expect(inFlight.has(claimed.userId), `group of user ${claimed.userId} is claimed twice`).to.equal(false);
                        inFlight.add(claimed.userId);
                        claims.push(claimed.updateId);
                        claimsByUser.set(claimed.userId, [...(claimsByUser.get(claimed.userId) ?? []), claimed.updateId]);
                    }

                    for (const claimed of batch) {
                        await sleep(Math.random() * 3);
                        inFlight.delete(claimed.userId);
                        await client.markAsDone(claimed);
                    }
                }
            };

            // A failed claimer stops the other one, which would otherwise keep going after the test.
            const claimer = (client: InboxStore): Promise<void> =>
                claim(client).catch((error: unknown) => {
                    hasFailed = true;
                    throw error;
                });

            await Promise.all([claimer(store), claimer(new InboxStore(other, logger, LEASE_DURATION_MS, CLEANUP))]);

            expect([...claims].sort((a, b) => a - b)).to.deep.equal(updateIds);

            for (const [userId, userClaims] of claimsByUser) {
                expect(userClaims, `group of user ${userId}`).to.deep.equal([...userClaims].sort((a, b) => a - b));
            }
        });
    });

    describe("the lease", function () {
        it("leases the claimed groups under the token of the claim for the lease duration", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);

            const claimed = await store.claim(10, WORKER);
            const [lockToken] = claimed.map((update) => update.lockToken);
            // Both columns are now() of the claim.
            const rows = await database.sql<{ user_id: string; lock_token: string; lease_ms: number }[]>`
                SELECT user_id, lock_token, extract(epoch FROM locked_until - updated_at)::double precision * ${MS_PER_SECOND} AS lease_ms
                FROM telegram_inbox_groups
            `;
            const leases = rows.map((row) => ({ userId: Number(row.user_id), lockToken: row.lock_token, leaseMs: row.lease_ms }));

            expect(claimed.map((update) => update.lockToken)).to.deep.equal([lockToken, lockToken]);
            expect(leases).to.have.deep.members([
                { userId: USER, lockToken, leaseMs: LEASE_DURATION_MS },
                { userId: OTHER_USER, lockToken, leaseMs: LEASE_DURATION_MS },
            ]);
        });

        it("gives every claim a token of its own", async function () {
            await store.pushBatch([input(10), input(11)]);
            const first = await claimOne();

            await store.markAsDone(first);

            expect((await claimOne()).lockToken).not.to.equal(first.lockToken);
        });
    });

    describe("markAsDone", function () {
        it("marks the update done with its end and ends the lease of its group", async function () {
            await store.push(input(10));

            await store.markAsDone(await claimOne());

            const [update] = await database.sql`SELECT status, finished_at IS NOT NULL AS finished FROM telegram_inbox`;
            const [lease] = await database.sql`SELECT locked_until, lock_token FROM telegram_inbox_groups`;

            expect(update).to.deep.equal({ status: InboxStatus.Done, finished: true });
            expect(lease).to.deep.equal({ locked_until: null, lock_token: null });
            expect(logger.warnings).to.deep.equal([]);
        });

        it("leaves the group ready while it has an update left", async function () {
            await store.pushBatch([input(10), input(11)]);

            await store.markAsDone(await claimOne());

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
        });

        it("refuses to mark done an update that does not exist", async function () {
            await expectNotLeased(lease(404, OTHER_TOKEN));
        });

        it("refuses a lease of its group that names another update of the group and changes nothing", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();

            await expectNotLeased(lease(11, claimed.lockToken));
            expect(await statuses()).to.deep.equal([InboxStatus.Processing, InboxStatus.Pending]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
        });
    });

    describe("a stale lock token", function () {
        it("changes nothing when the lease has passed to another claim, and logs a warning", async function () {
            await store.push(input(10));
            const claimed = await claimOne();

            await database.sql`UPDATE telegram_inbox_groups SET lock_token = ${OTHER_TOKEN}`;
            await store.markAsDone(claimed);
            await store.retry(claimed, TRANSIENT, 0);
            await store.markAsFailed(claimed, UNDELIVERABLE);
            await store.markAsFailedAndBlockGroup(claimed, UNEXPECTED);

            expect(await statuses()).to.deep.equal([InboxStatus.Processing]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
            expect(await attempts(10)).to.deep.equal([]);
            expect(logger.warnings).to.deep.equal(
                [null, TRANSIENT, UNDELIVERABLE, UNEXPECTED].map((cause) => ({
                    message: "Inbox completion with a stale lock token changed nothing.",
                    payload: {
                        updateId: 10,
                        lockToken: claimed.lockToken,
                        userId: USER,
                        chatId: CHAT,
                        groupLockToken: OTHER_TOKEN,
                        cause: cause,
                    },
                })),
            );
            expect(logger.errors).to.deep.equal([]);
        });

        it("changes nothing on a second completion of the same claim", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();

            await store.markAsDone(claimed);
            await store.markAsFailedAndBlockGroup(claimed, UNEXPECTED);

            expect(await statuses()).to.deep.equal([InboxStatus.Done, InboxStatus.Pending]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect(logger.warnings.map(({ payload }) => payload?.["groupLockToken"])).to.deep.equal([null]);
            expect(logger.errors).to.deep.equal([]);
        });

        it("changes nothing for a token no claim gave out", async function () {
            await store.push(input(10));

            await store.markAsDone(lease(10, OTHER_TOKEN));

            expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect(logger.warnings).to.have.lengthOf(1);
        });
    });

    describe("the attempts", function () {
        it("writes no attempt on a claim and one of the worker, without an error, when the update is done", async function () {
            await store.push(input(10));
            const claimed = await claimOne();

            expect(await attempts(10)).to.deep.equal([]);
            expect(claimed.earlierAttempts).to.equal(0);

            await store.markAsDone(claimed);
            const [attempt] = await attempts(10);

            expect(attempt).to.deep.include({
                started_at: claimed.startedAt,
                worker: { host: WORKER.host, pid: WORKER.pid, worker_id: WORKER.workerId },
                error: null,
            });
            expect((attempt?.finished_at as string) >= claimed.startedAt).to.equal(true);
        });

        it("keeps every attempt of an update in the order they were made", async function () {
            await store.push(input(10));

            await store.retry(await claimOne(), TRANSIENT, 0);
            await store.markAsDone(await claimOne());

            const history = await attempts(10);

            expect(history.map(({ error }) => error)).to.deep.equal([TRANSIENT, null]);
            expect((history[0]?.finished_at as string) <= (history[1]?.started_at as string)).to.equal(true);
        });

        it("gives out the number of earlier attempts with a claim, whatever they ended with", async function () {
            await store.push(input(10));

            await store.retry(await claimOne(), TRANSIENT, 0);
            await store.retry(await claimOne(), UNEXPECTED, 0);

            expect((await claimOne()).earlierAttempts).to.equal(2);
        });
    });

    describe("outcomes", function () {
        it("returns a retried update to pending, closes its attempt with the error and ends the lease", async function () {
            await store.push(input(10));

            await store.retry(await claimOne(), TRANSIENT, LONG_RETRY_DELAY_MS);

            const [lease] = await database.sql`SELECT locked_until, lock_token FROM telegram_inbox_groups`;

            expect(await statuses()).to.deep.equal([InboxStatus.Pending]);
            expect(await isFinished(10)).to.equal(false);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect(lease).to.deep.equal({ locked_until: null, lock_token: null });
            expect((await attempts(10)).map(({ error }) => error)).to.deep.equal([TRANSIENT]);
        });

        it("holds the group of a head waiting for its retry and lets the other groups through", async function () {
            await store.pushBatch([input(10), input(11)]);
            await store.retry(await claimOne(), TRANSIENT, LONG_RETRY_DELAY_MS);
            await store.push(input(20, OTHER_USER, CHAT));

            const [waiting] = await database.sql<{ wait_ms: number }[]>`
                SELECT extract(epoch FROM next_attempt_at - now())::double precision * ${MS_PER_SECOND} AS wait_ms
                FROM telegram_inbox_groups
                WHERE user_id = ${USER}
            `;

            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([20]);
            expect(waiting?.wait_ms).to.be.within(LONG_RETRY_DELAY_MS - ELAPSED_TOLERANCE_MS, LONG_RETRY_DELAY_MS);

            await database.sql`UPDATE telegram_inbox_groups SET next_attempt_at = now() WHERE user_id = ${USER}`;

            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([10]);
        });

        it("fails an undeliverable update and goes on to the next update of its group", async function () {
            await store.pushBatch([input(10), input(11)]);

            await store.markAsFailed(await claimOne(), UNDELIVERABLE);

            expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending]);
            expect(await isFinished(10)).to.equal(true);
            expect((await attempts(10)).map(({ error }) => error)).to.deep.equal([UNDELIVERABLE]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect((await claimOne()).updateId).to.equal(11);
            expect(logger.errors).to.deep.equal([]);
        });

        it("leaves a group idle when its last update fails without blocking it", async function () {
            await store.push(input(10));

            await store.markAsFailed(await claimOne(), UNDELIVERABLE);

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
            expect(await store.claim(10, WORKER)).to.deep.equal([]);
        });

        it("fails an update and blocks its group, the updates behind it and the new ones included", async function () {
            await store.pushBatch([input(10), input(11)]);

            await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);
            await store.push(input(12));

            expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending, InboxStatus.Pending]);
            expect(await isFinished(10)).to.equal(true);
            expect((await attempts(10)).map(({ error }) => error)).to.deep.equal([UNEXPECTED]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            expect(await store.claim(10, WORKER)).to.deep.equal([]);
            expect(logger.errors).to.deep.equal([
                {
                    message: "Inbox group is blocked by a failed update.",
                    payload: { userId: USER, chatId: CHAT, updateId: 10, cause: UNEXPECTED },
                },
            ]);
        });
    });

    describe("expired leases", function () {
        beforeEach(function () {
            store = new InboxStore(database, logger, SHORT_LEASE_MS, CLEANUP);
        });

        it("finds a group whose lease has passed with its update, the start of the claim and no worker", async function () {
            await store.pushBatch([input(10), input(11)]);
            await store.retry(await claimOne(), TRANSIENT, 0);
            const claimed = await claimOne();
            await sleep(SHORT_LEASE_MS * 2);

            expect(await store.findExpiredLeases()).to.deep.equal([
                { updateId: 10, lockToken: claimed.lockToken, startedAt: claimed.startedAt, worker: null, earlierAttempts: 1 },
            ]);
        });

        it("leaves alone a lease that has not passed and a group that is not leased", async function () {
            await store.push(input(10, USER, CHAT));
            await claimOne();
            const longLeasing = new InboxStore(database, logger, LEASE_DURATION_MS, CLEANUP);
            await longLeasing.push(input(20, OTHER_USER, CHAT));
            expect((await longLeasing.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([20]);
            await store.push(input(30, USER, GROUP_CHAT));
            await sleep(SHORT_LEASE_MS * 2);

            expect((await store.findExpiredLeases()).map(({ updateId }) => updateId)).to.deep.equal([10]);
        });

        it("finds the processing update of an expired group behind an update pushed with a smaller update_id", async function () {
            await store.push(input(10));
            await claimOne();
            await store.push(input(5));
            await sleep(SHORT_LEASE_MS * 2);

            expect((await store.findExpiredLeases()).map(({ updateId }) => updateId)).to.deep.equal([10]);
        });

        it("gives one lease per expired group, its first processing update by update_id, however many are processing", async function () {
            await store.push(input(10));
            await claimOne();
            await store.push(input(5));
            // No writer makes a second processing update in a group.
            await database.sql`UPDATE telegram_inbox SET status = ${InboxStatus.Processing} WHERE update_id = 5`;
            await sleep(SHORT_LEASE_MS * 2);

            expect((await store.findExpiredLeases()).map(({ updateId }) => updateId)).to.deep.equal([5]);
        });

        it("closes the attempt of an expired lease with no worker", async function () {
            await store.push(input(10));
            const claimed = await claimOne();
            await sleep(SHORT_LEASE_MS * 2);
            const [expired] = await store.findExpiredLeases();

            await store.retry(expired as ExpiredInboxLease, EXPIRED_LEASE_ERROR, 0);

            const [attempt] = await attempts(10);

            expect(attempt).to.deep.include({ started_at: claimed.startedAt, worker: null, error: EXPIRED_LEASE_ERROR });
        });
    });

    describe("extending the lease", function () {
        // The lease each group has left, from the last write of its row: the claim or the extension;
        // null for a group not leased.
        async function leasesMs(): Promise<(number | null)[]> {
            const rows = await database.sql<{ lease_ms: number | null }[]>`
                SELECT extract(epoch FROM locked_until - updated_at)::double precision * ${MS_PER_SECOND} AS lease_ms
                FROM telegram_inbox_groups
                ORDER BY user_id, chat_id
            `;

            return rows.map((row) => row.lease_ms);
        }

        it("moves the end of a lease that has not passed to the lease duration from now, past the recovery", async function () {
            const briefLeasing = new InboxStore(database, logger, BRIEF_LEASE_MS, CLEANUP);
            await briefLeasing.push(input(10));
            const [claimed] = await briefLeasing.claim(10, WORKER);

            expect(await store.extendLease(claimed as ClaimedInboxUpdate)).to.equal(true);
            expect(await leasesMs()).to.deep.equal([LEASE_DURATION_MS]);

            await sleep(BRIEF_LEASE_MS * 2);

            expect(await briefLeasing.findExpiredLeases()).to.deep.equal([]);
        });

        it("leaves the start of the claim to the recovery of a lease extended before it passed", async function () {
            const briefLeasing = new InboxStore(database, logger, BRIEF_LEASE_MS, CLEANUP);
            const shortLeasing = new InboxStore(database, logger, SHORT_LEASE_MS, CLEANUP);
            await briefLeasing.push(input(10));
            const [claimed] = await briefLeasing.claim(10, WORKER);

            expect(await shortLeasing.extendLease(claimed as ClaimedInboxUpdate)).to.equal(true);
            await sleep(SHORT_LEASE_MS * 2);

            expect((await shortLeasing.findExpiredLeases()).map(({ startedAt }) => startedAt)).to.deep.equal([claimed?.startedAt]);
        });

        it("extends only the group of the update, not the other groups of the same claim", async function () {
            const briefLeasing = new InboxStore(database, logger, BRIEF_LEASE_MS, CLEANUP);
            await briefLeasing.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);
            const [claimed] = await briefLeasing.claim(10, WORKER);

            expect(await store.extendLease(claimed as ClaimedInboxUpdate)).to.equal(true);
            expect(await leasesMs()).to.deep.equal([LEASE_DURATION_MS, BRIEF_LEASE_MS]);
        });

        it("does not extend a lease that has passed, and leaves it to the recovery", async function () {
            const shortLeasing = new InboxStore(database, logger, SHORT_LEASE_MS, CLEANUP);
            await shortLeasing.push(input(10));
            const [claimed] = await shortLeasing.claim(10, WORKER);
            await sleep(SHORT_LEASE_MS * 2);

            expect(await store.extendLease(claimed as ClaimedInboxUpdate)).to.equal(false);
            expect((await shortLeasing.findExpiredLeases()).map(({ updateId }) => updateId)).to.deep.equal([10]);
        });

        // An extension by a store of another duration would show in the lease left.
        const longerLeasing = (): InboxStore => new InboxStore(database, logger, LEASE_DURATION_MS * 2, CLEANUP);

        it("does not extend a lease under a stale token or one no claim gave out", async function () {
            await store.pushBatch([input(10), input(11)]);
            const retried = await claimOne();
            await store.retry(retried, TRANSIENT, 0);
            await claimOne();

            expect(await longerLeasing().extendLease(retried)).to.equal(false);
            expect(await longerLeasing().extendLease(lease(10, OTHER_TOKEN))).to.equal(false);
            expect(await leasesMs()).to.deep.equal([LEASE_DURATION_MS]);
        });

        it("does not extend a lease its completion has ended", async function () {
            await store.push(input(10));
            const done = await claimOne();
            await store.markAsDone(done);

            expect(await longerLeasing().extendLease(done)).to.equal(false);
            expect(await leasesMs()).to.deep.equal([null]);
        });
    });

    describe("the cleanup of finished updates", function () {
        // Updates of one group by status, each ended the given time ago; their ids.
        async function finishedAgo(...rows: Array<{ status: InboxStatus; agoMs: number }>): Promise<number[]> {
            const updateIds = rows.map((_, index) => 100 + index);
            await store.pushBatch(updateIds.map((updateId) => input(updateId)));

            for (const [index, { status, agoMs }] of rows.entries()) {
                await database.sql`
                    UPDATE telegram_inbox
                    SET status = ${status},
                        finished_at = now() - ${agoMs}::double precision * interval '1 millisecond'
                    WHERE update_id = ${updateIds[index] as number}
                `;
            }

            return updateIds;
        }

        async function updateIds(): Promise<number[]> {
            const rows = await database.sql<{ update_id: string }[]>`SELECT update_id FROM telegram_inbox ORDER BY update_id`;

            return rows.map((row) => Number(row.update_id));
        }

        // A minute on either side of a retention: far more than the spec takes to run.
        const MARGIN_MS = 60 * MS_PER_SECOND;

        it("deletes a done update once its retention has passed and keeps a younger one", async function () {
            const [, younger] = await finishedAgo(
                { status: InboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS },
                { status: InboxStatus.Done, agoMs: CLEANUP.doneRetentionMs - MARGIN_MS },
            );

            expect(await store.deleteFinishedUpdates()).to.equal(1);
            expect(await updateIds()).to.deep.equal([younger]);
        });

        it("keeps a skipped update for its own retention, not that of a done one", async function () {
            const [, younger] = await finishedAgo(
                { status: InboxStatus.Skipped, agoMs: CLEANUP.skippedRetentionMs + MARGIN_MS },
                { status: InboxStatus.Skipped, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS },
            );

            expect(await store.deleteFinishedUpdates()).to.equal(1);
            expect(await updateIds()).to.deep.equal([younger]);
        });

        it("never deletes a failed update or an active one, however old", async function () {
            const ages = [InboxStatus.Failed, InboxStatus.Pending, InboxStatus.Processing].map((status) => ({
                status,
                agoMs: 1000 * CLEANUP.skippedRetentionMs,
            }));
            const kept = await finishedAgo(...ages);

            expect(await store.deleteFinishedUpdates()).to.equal(0);
            expect(await updateIds()).to.deep.equal(kept);
        });

        it("never deletes a done or a skipped update without its end", async function () {
            const kept = await finishedAgo(
                { status: InboxStatus.Done, agoMs: 1000 * CLEANUP.skippedRetentionMs },
                { status: InboxStatus.Skipped, agoMs: 1000 * CLEANUP.skippedRetentionMs },
            );
            await database.sql`UPDATE telegram_inbox SET finished_at = NULL`;

            expect(await store.deleteFinishedUpdates()).to.equal(0);
            expect(await updateIds()).to.deep.equal(kept);
        });

        // Another cleanup, or a person moving the update back by hand, holds the row.
        it("skips an update another transaction holds and deletes the rest", async function () {
            const old = { status: InboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS };
            const [held] = await finishedAgo(old, old);
            let deleted = 0;

            await other.sql.begin(async (sql) => {
                await sql`SELECT update_id FROM telegram_inbox WHERE update_id = ${held as number} FOR UPDATE`;

                deleted = await store.deleteFinishedUpdates();
            });

            expect(deleted).to.equal(1);
            expect(await updateIds()).to.deep.equal([held]);
        });

        it("deletes no more updates in one call than the batch size", async function () {
            const batched = new InboxStore(database, logger, LEASE_DURATION_MS, { ...CLEANUP, batchSize: 2 });
            const old = { status: InboxStatus.Done, agoMs: CLEANUP.doneRetentionMs + MARGIN_MS };
            await finishedAgo(old, old, old);

            expect(await batched.deleteFinishedUpdates()).to.equal(2);
            expect(await updateIds()).to.have.lengthOf(1);
            expect(await batched.deleteFinishedUpdates()).to.equal(1);
            expect(await updateIds()).to.deep.equal([]);
        });

        // The row is what turns a redelivered update away.
        it("turns a redelivered update away while its done row is kept", async function () {
            await store.push(input(10));
            await store.markAsDone(await claimOne());
            await store.deleteFinishedUpdates();

            await store.push(input(10));

            expect(await statuses()).to.deep.equal([InboxStatus.Done]);
        });
    });

    describe("the cleanup of idle groups", function () {
        async function idleGroup(userId: number): Promise<void> {
            await store.push(input(userId, userId, CHAT));
            await store.markAsDone(await claimOne());
        }

        it("removes an idle group and leaves its updates", async function () {
            await idleGroup(USER);

            expect(await store.deleteIdleGroups()).to.equal(1);
            expect(await group(USER, CHAT)).to.equal(undefined);
            expect(await statuses()).to.deep.equal([InboxStatus.Done]);
        });

        it("keeps a ready, a processing and a blocked group", async function () {
            await store.push(input(1, 1, CHAT));
            await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);
            await store.push(input(2, 2, CHAT));
            await claimOne();
            await store.push(input(3, 3, CHAT));

            expect(await store.deleteIdleGroups()).to.equal(0);
            expect(await group(1, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            expect(await group(2, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
            expect(await group(3, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
        });

        it("removes no more groups in one call than the batch size", async function () {
            const batched = new InboxStore(database, logger, LEASE_DURATION_MS, { ...CLEANUP, batchSize: 2 });
            for (const userId of [1, 2, 3]) {
                await idleGroup(userId);
            }

            expect(await batched.deleteIdleGroups()).to.equal(2);
            expect(await batched.deleteIdleGroups()).to.equal(1);
        });

        it("changes nothing on a late completion of a removed group, and logs a warning", async function () {
            await store.push(input(10));
            const claimed = await claimOne();
            await store.markAsDone(claimed);
            await store.deleteIdleGroups();

            await store.markAsDone(claimed);
            await store.markAsFailedAndBlockGroup(claimed, UNEXPECTED);

            expect(await statuses()).to.deep.equal([InboxStatus.Done]);
            expect(logger.warnings).to.deep.equal(
                [null, UNEXPECTED].map((cause) => ({
                    message: "Inbox completion of a group the cleanup removed changed nothing.",
                    payload: { updateId: 10, lockToken: claimed.lockToken, cause: cause },
                })),
            );
            expect(logger.errors).to.deep.equal([]);
        });

        it("still rejects the completion of an update that is not stored", async function () {
            await expectNotLeased(lease(404, OTHER_TOKEN));
        });
    });

    describe("the blocked groups", function () {
        it("counts nothing in an empty inbox", async function () {
            expect(await store.countBlockedGroups()).to.equal(0);
        });

        it("counts the blocked groups alone", async function () {
            const [firstBlockedUser, secondBlockedUser, idleUser, processingUser, readyUser] = [1, 2, 3, 4, 5];
            for (const blockedUser of [firstBlockedUser, secondBlockedUser]) {
                await store.push(input(blockedUser, blockedUser, CHAT));
                await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);
            }
            await store.push(input(idleUser, idleUser, CHAT));
            await store.markAsDone(await claimOne());
            await store.push(input(processingUser, processingUser, CHAT));
            await claimOne();
            await store.push(input(readyUser, readyUser, CHAT));

            expect(await store.countBlockedGroups()).to.equal(2);
        });
    });

    describe("a concurrent push and removal of its group", function () {
        beforeEach(async function () {
            await store.push(input(10));
            await store.markAsDone(await claimOne());
        });

        // The holder stands in for a push or a completion of the group.
        it("leaves a group another transaction holds to it", async function () {
            let removed = -1;

            await other.sql.begin(async (sql) => {
                await sql`SELECT user_id FROM telegram_inbox_groups WHERE user_id = ${USER} AND chat_id = ${CHAT} FOR UPDATE`;

                removed = await store.deleteIdleGroups();
            });

            expect(removed).to.equal(0);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
        });

        // The removal runs in the transaction that holds the group, so it takes the group while the push
        // waits for it. A push that found the row in one statement and locked it in the next would find
        // it gone and put its update in without a group, where no claim reaches it.
        it("recreates the group of a push that waited for its removal", async function () {
            let pushing: Promise<void> = Promise.resolve();
            let removed = 0;

            await other.sql.begin(async (sql) => {
                await sql`SELECT user_id FROM telegram_inbox_groups WHERE user_id = ${USER} AND chat_id = ${CHAT} FOR UPDATE`;

                pushing = store.push(input(11));

                await waitForLockWaiters(observer, 1);

                removed = await storeOn(sql).deleteIdleGroups();
            });

            await pushing;

            expect(removed).to.equal(1);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
        });
    });

    describe("a concurrent push and completion", function () {
        // The third client holds the group row, the store calls queue up behind it in a known order,
        // and the order decides which of them sees the other.
        async function race(first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> {
            let calls: Promise<unknown> = Promise.resolve();

            // The transaction commits on return and lets the waiting calls through.
            await other.sql.begin(async (sql) => {
                await sql`SELECT user_id FROM telegram_inbox_groups WHERE user_id = ${USER} AND chat_id = ${CHAT} FOR UPDATE`;

                const firstCall = first();

                await waitForLockWaiters(observer, 1);

                calls = Promise.all([firstCall, second()]);

                await waitForLockWaiters(observer, 2);
            });

            await calls;
        }

        let processing: ClaimedInboxUpdate;

        beforeEach(async function () {
            await store.push(input(10));
            processing = await claimOne();
        });

        const push = (): Promise<void> => store.push(input(11));
        const complete = (): Promise<void> => store.markAsDone(processing);

        it("leaves the group ready with the new head when the push locks the group first", async function () {
            await race(push, complete);

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
        });

        it("leaves the group ready with the new head when the completion locks the group first", async function () {
            await race(complete, push);

            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
            expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
        });
    });

    describe("ready notifications", function () {
        // A client of its own per test: closed at the end, it takes its LISTEN connection along, so
        // the next test counts only its own.
        let listener: Database;

        beforeEach(function () {
            listener = new Database(settings, false);
        });

        afterEach(async function () {
            await listener.close();
        });

        // The notifications of the ready channel the operation sends, in the order of the commits: the
        // sentinel goes after the operation's own, so one that is not in the list was not sent.
        async function readyNotificationsOf(operation: () => Promise<unknown>): Promise<string[]> {
            const payloads = await listenTo(listener, InboxChannel.Ready);

            await operation();
            await database.sql`SELECT pg_notify(${InboxChannel.Ready}, 'sentinel')`;
            await waitUntil(() => payloads.includes("sentinel"), "no sentinel notification came");

            return payloads.filter((payload) => payload !== "sentinel");
        }

        it("calls the ready listener when the listening starts and when a push commits", async function () {
            let readyCount = 0;
            await new InboxStore(listener, logger, LEASE_DURATION_MS, CLEANUP).listenReady(() => (readyCount += 1));

            expect(readyCount).to.equal(1);

            await store.push(input(10));

            await waitUntil(() => readyCount === 2, "no ready notification came");
        });

        it("notifies once when a push makes groups ready", async function () {
            const payloads = await readyNotificationsOf(() => store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]));

            expect(payloads).to.deep.equal([""]);
        });

        it("does not notify of a push that makes no group ready", async function () {
            await store.push(input(10));
            await claimOne();

            const payloads = await readyNotificationsOf(async () => {
                // A redelivery, and a new update of a processing group.
                await store.push(input(10));
                await store.push(input(11));
            });

            expect(payloads).to.deep.equal([]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
        });

        it("notifies when a done update leaves its group ready", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();

            const payloads = await readyNotificationsOf(() => store.markAsDone(claimed));

            expect(payloads).to.deep.equal([""]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
        });

        it("notifies when a failed update leaves its group ready", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();

            const payloads = await readyNotificationsOf(() => store.markAsFailed(claimed, UNDELIVERABLE));

            expect(payloads).to.deep.equal([""]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
        });

        it("notifies when a retry makes its group ready", async function () {
            await store.push(input(10));
            const claimed = await claimOne();

            const payloads = await readyNotificationsOf(() => store.retry(claimed, TRANSIENT, LONG_RETRY_DELAY_MS));

            expect(payloads).to.deep.equal([""]);
        });

        it("does not notify when the last update done or failed leaves its group idle", async function () {
            await store.pushBatch([input(10, USER, CHAT), input(11, OTHER_USER, CHAT)]);
            const [done, failed] = await store.claim(10, WORKER);

            const payloads = await readyNotificationsOf(async () => {
                await store.markAsDone(done as ClaimedInboxUpdate);
                await store.markAsFailed(failed as ClaimedInboxUpdate, UNDELIVERABLE);
            });

            expect(payloads).to.deep.equal([]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
            expect(await group(OTHER_USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
        });

        it("does not notify when a failed update blocks its group", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();

            const payloads = await readyNotificationsOf(() => store.markAsFailedAndBlockGroup(claimed, UNEXPECTED));

            expect(payloads).to.deep.equal([]);
        });

        it("notifies when a blocked group is retried or skipped with an update left", async function () {
            await store.pushBatch([input(10), input(11)]);
            await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);

            const payloads = await readyNotificationsOf(async () => {
                await store.retryBlockedGroup({ userId: USER, chatId: CHAT });
                await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);
                await store.skipBlockedGroup({ userId: USER, chatId: CHAT });
            });

            expect(payloads).to.deep.equal(["", ""]);
        });

        it("does not notify of a fenced completion", async function () {
            await store.pushBatch([input(10), input(11)]);
            const stale = await claimOne();
            await store.retry(stale, TRANSIENT, 0);
            await claimOne();

            const payloads = await readyNotificationsOf(async () => {
                await store.markAsDone(stale);
                await store.markAsFailed(stale, UNDELIVERABLE);
                await store.retry(stale, TRANSIENT, 0);
            });

            expect(payloads).to.deep.equal([]);
        });

        it("does not notify of a completion that rolls back", async function () {
            await store.pushBatch([input(10), input(11)]);
            const claimed = await claimOne();
            let rollback: unknown;

            const payloads = await readyNotificationsOf(async () => {
                rollback = await new InboxStore(rollingBackDatabase(database), logger, LEASE_DURATION_MS, CLEANUP).markAsDone(claimed).then(
                    () => expect.fail("markAsDone() was expected to roll back"),
                    (reason: unknown) => reason,
                );
            });

            // The rollback of the spec, not an error of the completion, and no warning of a fenced one:
            // the completion ran to its end.
            expect((rollback as Error).message).to.equal(SPEC_ROLLBACK_MESSAGE);
            expect(logger.warnings).to.deep.equal([]);
            expect(payloads).to.deep.equal([]);
            expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Processing });
        });
    });

    // A store whose statements run in the given transaction.
    function storeOn(transaction: TransactionSql): InboxStore {
        return new InboxStore({ sql: transaction } as unknown as Database, logger, LEASE_DURATION_MS, CLEANUP);
    }

    describe("unblocking a group", function () {
        const GROUP = { userId: USER, chatId: CHAT };

        // Pushes the updates, fails the first one with its group blocked; the id of the failed one and
        // of the updates behind it.
        async function blockGroup(...updateIds: number[]): Promise<{ failedId: number; behindIds: number[] }> {
            await store.pushBatch(updateIds.map((updateId) => input(updateId)));
            await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);

            const [failedId, ...behindIds] = updateIds;

            return { failedId: failedId as number, behindIds };
        }

        async function expectNotBlocked(unblock: () => Promise<number>): Promise<void> {
            const error = await unblock().then(
                () => expect.fail("the unblock was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.be.instanceOf(InboxGroupNotBlocked);
            expect((error as InboxGroupNotBlocked).payload).to.deep.equal({ userId: USER, chatId: CHAT });
        }

        // Every update and every group, for a spec that pins that a refused call changed nothing.
        async function snapshot(): Promise<unknown> {
            const updates =
                await database.sql`SELECT update_id, status, finished_at, updated_at, attempts FROM telegram_inbox ORDER BY update_id`;
            const groups =
                await database.sql`SELECT user_id, chat_id, state, next_attempt_at, updated_at FROM telegram_inbox_groups ORDER BY user_id, chat_id`;

            return { updates: [...updates], groups: [...groups] };
        }

        describe("retry", function () {
            it("puts the failed update back to pending as the head of its group and returns it", async function () {
                const { failedId, behindIds } = await blockGroup(10, 11);

                expect(await store.retryBlockedGroup(GROUP)).to.equal(failedId);

                expect(await statuses()).to.deep.equal([InboxStatus.Pending, InboxStatus.Pending]);
                expect(await isFinished(failedId)).to.equal(false);
                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
                expect(await drain(store)).to.deep.equal([failedId, ...behindIds]);
            });

            it("keeps the attempts the failed update has made", async function () {
                const { failedId } = await blockGroup(10);

                await store.retryBlockedGroup(GROUP);

                expect(await attempts(failedId)).to.have.lengthOf(1);
                expect((await attempts(failedId))[0]?.error).to.deep.equal(UNEXPECTED);
            });

            it("takes the update that blocked the group, not an earlier one that failed without blocking it", async function () {
                await store.pushBatch([input(10), input(11)]);
                await store.markAsFailed(await claimOne(), UNDELIVERABLE);
                await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);

                expect(await store.retryBlockedGroup(GROUP)).to.equal(11);

                expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Pending]);
                expect((await claimOne()).updateId).to.equal(11);
            });

            for (const [name, prepare] of [
                ["a group that is not in the inbox", async (): Promise<unknown> => undefined],
                ["a ready group", async (): Promise<unknown> => store.push(input(10))],
                [
                    "a processing group",
                    async (): Promise<void> => {
                        await store.push(input(10));
                        await claimOne();
                    },
                ],
                [
                    "an idle group",
                    async (): Promise<unknown> =>
                        database.sql`INSERT INTO telegram_inbox_groups (user_id, chat_id, state) VALUES (${USER}, ${CHAT}, ${InboxGroupState.Idle})`,
                ],
            ] as const) {
                it(`refuses ${name} and changes nothing`, async function () {
                    await prepare();
                    const before = await snapshot();

                    await expectNotBlocked(() => store.retryBlockedGroup(GROUP));

                    expect(await snapshot()).to.deep.equal(before);
                });
            }

            it("refuses a blocked group with no failed update and leaves it blocked", async function () {
                await database.sql`INSERT INTO telegram_inbox_groups (user_id, chat_id, state) VALUES (${USER}, ${CHAT}, ${InboxGroupState.Blocked})`;

                await expectNotBlocked(() => store.retryBlockedGroup(GROUP));

                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            });

            it("leaves the other blocked groups blocked", async function () {
                await blockGroup(10);
                await store.push(input(20, OTHER_USER, CHAT));
                await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);

                await store.retryBlockedGroup(GROUP);

                expect(await group(OTHER_USER, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            });
        });

        describe("skip", function () {
            it("skips the failed update and goes on with the update behind it", async function () {
                const { failedId, behindIds } = await blockGroup(10, 11);

                expect(await store.skipBlockedGroup(GROUP)).to.equal(failedId);

                expect(await statuses()).to.deep.equal([InboxStatus.Skipped, InboxStatus.Pending]);
                expect(await isFinished(failedId)).to.equal(true);
                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
                expect(await drain(store)).to.deep.equal(behindIds);
            });

            // A ready group with no head would be claimed by nothing, and a loop of the handler would
            // spin on it.
            it("leaves a group idle when the skipped update was its only active one", async function () {
                const { failedId } = await blockGroup(10);

                expect(await store.skipBlockedGroup(GROUP)).to.equal(failedId);

                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Idle });
                expect(await store.claim(10, WORKER)).to.deep.equal([]);
            });

            it("takes the update that blocked the group and leaves an earlier failed one as it is", async function () {
                await store.pushBatch([input(10), input(11)]);
                await store.markAsFailed(await claimOne(), UNDELIVERABLE);
                await store.markAsFailedAndBlockGroup(await claimOne(), UNEXPECTED);

                expect(await store.skipBlockedGroup(GROUP)).to.equal(11);

                expect(await statuses()).to.deep.equal([InboxStatus.Failed, InboxStatus.Skipped]);
            });

            for (const [name, prepare] of [
                ["a group that is not in the inbox", async (): Promise<unknown> => undefined],
                ["a ready group", async (): Promise<unknown> => store.push(input(10))],
            ] as const) {
                it(`refuses ${name} and changes nothing`, async function () {
                    await prepare();
                    const before = await snapshot();

                    await expectNotBlocked(() => store.skipBlockedGroup(GROUP));

                    expect(await snapshot()).to.deep.equal(before);
                });
            }

            it("refuses a blocked group with no failed update and leaves it blocked", async function () {
                await database.sql`INSERT INTO telegram_inbox_groups (user_id, chat_id, state) VALUES (${USER}, ${CHAT}, ${InboxGroupState.Blocked})`;

                await expectNotBlocked(() => store.skipBlockedGroup(GROUP));

                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Blocked });
            });
        });

        // The third client holds the group row, the unblock and a push queue up behind it in a known
        // order, and the order decides which of them sees the other.
        describe("concurrent with a push", function () {
            async function race(first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> {
                let calls: Promise<unknown> = Promise.resolve();

                await other.sql.begin(async (sql) => {
                    await sql`SELECT user_id FROM telegram_inbox_groups WHERE user_id = ${USER} AND chat_id = ${CHAT} FOR UPDATE`;

                    const firstCall = first();

                    await waitForLockWaiters(observer, 1);

                    calls = Promise.all([firstCall, second()]);

                    await waitForLockWaiters(observer, 2);
                });

                await calls;
            }

            beforeEach(async function () {
                await blockGroup(10);
            });

            const skip = async (): Promise<void> => {
                await store.skipBlockedGroup(GROUP);
            };
            const push = (): Promise<void> => store.push(input(11));

            it("leaves the group ready with the new head when the push locks the group first", async function () {
                await race(push, skip);

                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
                expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
            });

            it("leaves the group ready with the new head when the skip locks the group first", async function () {
                await race(skip, push);

                expect(await group(USER, CHAT)).to.deep.equal({ state: InboxGroupState.Ready });
                expect((await store.claim(10, WORKER)).map(({ updateId }) => updateId)).to.deep.equal([11]);
            });
        });
    });

    async function group(userId: number, chatId: number): Promise<GroupRow | undefined> {
        const [row] = await database.sql<GroupRow[]>`
            SELECT state
            FROM telegram_inbox_groups
            WHERE user_id = ${userId}
              AND chat_id = ${chatId}
        `;

        return row;
    }

    async function statuses(): Promise<string[]> {
        const rows = await database.sql<{ status: string }[]>`SELECT status FROM telegram_inbox ORDER BY update_id`;

        return rows.map((row) => row.status);
    }

    async function attempts(updateId: number): Promise<InboxAttempt[]> {
        const [row] = await database.sql<{ attempts: InboxAttempt[] }[]>`SELECT attempts FROM telegram_inbox WHERE update_id = ${updateId}`;

        return row?.attempts ?? [];
    }

    async function isFinished(updateId: number): Promise<boolean> {
        const [row] = await database.sql<{ finished: boolean }[]>`
            SELECT finished_at IS NOT NULL AS finished
            FROM telegram_inbox
            WHERE update_id = ${updateId}
        `;

        return row?.finished ?? false;
    }

    async function expectNotLeased(notLeased: InboxLease): Promise<void> {
        const error = await store.markAsDone(notLeased).then(
            () => expect.fail("markAsDone() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InboxUpdateNotLeased);
        expect((error as InboxUpdateNotLeased).payload).to.deep.equal({ updateId: notLeased.updateId });
    }

    // The only update a claim gives out.
    async function claimOne(): Promise<ClaimedInboxUpdate> {
        const claimed = await store.claim(10, WORKER);

        expect(claimed).to.have.lengthOf(1);

        return claimed[0] as ClaimedInboxUpdate;
    }
});

// A message update of the user in the chat.
function input(updateId: number, userId = USER, chatId = CHAT, text = "text"): InboxUpdateInput {
    return messageInput(updateId, userId, chatId, text);
}

// A lease the spec makes up rather than takes from a claim.
function lease(updateId: number, lockToken: string): InboxLease {
    return { updateId, lockToken, startedAt: "2026-01-01T00:00:00+00:00", worker: null };
}

// Claims one update at a time and marks it done until the inbox is empty; the update ids in claim
// order.
async function drain(store: InboxStore): Promise<number[]> {
    const updateIds: number[] = [];

    for (;;) {
        const [claimed] = await store.claim(1, WORKER);

        if (claimed === undefined) {
            return updateIds;
        }

        updateIds.push(claimed.updateId);
        await store.markAsDone(claimed);
    }
}
