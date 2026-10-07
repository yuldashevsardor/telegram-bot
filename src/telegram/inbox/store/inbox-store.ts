import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";
import postgres from "postgres";
import type { PendingQuery, Row, TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import { isJsonbStorable } from "app/telegram/jsonb-string";
import type {
    ClaimedInboxRow,
    ClaimedInboxUpdate,
    ExpiredInboxLease,
    ExpiredInboxLeaseRow,
    InboxAttempt,
    InboxAttemptError,
    InboxCleanupSettings,
    InboxGroupKey,
    InboxLease,
    InboxUpdateInput,
    InboxWorker,
    LockedInboxGroupRow,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxChannel, InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import {
    InboxGroupNotBlocked,
    InboxPushFailed,
    InboxUpdateNotLeased,
    InboxUpdateRefused,
    InvalidClaimLimit,
} from "app/telegram/inbox/store/inbox-store.errors";

// The OID of bigint: the user and chat ids of the groups go to the database as bigint[] parameters.
const BIGINT = 20;

// The statuses a group head can be in: its first update by update_id among them. A failed update is
// not among them: the group it blocks is held by its state, and one that does not block lets the
// next update through.
const ACTIVE_STATUSES = [InboxStatus.Pending, InboxStatus.Processing];

// The SQLSTATE codes PostgreSQL refuses the values of an update in jsonb with, and the same update
// fails every time it is pushed: untranslatable_character for a \u0000 escape and
// invalid_text_representation for a lone surrogate. Not the whole class 22 of data exceptions: a
// change of the store that fails every row with another of them would drop every update instead of
// stalling the polling source.
const REFUSED_UPDATE_SQLSTATES: ReadonlySet<string> = new Set(["22P05", "22P02"]);

// The rows and the group states of the inbox: the model is in docs/architecture/inbox.md.
@injectable()
export class InboxStore {
    private readonly sql: Sql;

    public constructor(
        @inject<Database>(Tokens.Platform.Database) database: Database,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly leaseDurationMs: number = configValue("inbox.leaseDurationMs"),
        private readonly cleanupSettings: InboxCleanupSettings = configValue("inbox.cleanup"),
    ) {
        this.sql = database.sql;
    }

    public async push(input: InboxUpdateInput): Promise<void> {
        await this.pushBatch([input]);
    }

    // The updates and their groups commit together. An update whose update_id is stored already is
    // left out: Telegram delivers an update again when it did not learn that the bot got it
    // (docs/architecture/inbox.md, "Push"). An error of PostgreSQL is thrown as InboxUpdateRefused
    // when the updates themselves caused it, and as InboxPushFailed otherwise.
    public async pushBatch(inputs: InboxUpdateInput[]): Promise<void> {
        // An empty getUpdates is the common answer of a poll: it costs no transaction.
        if (inputs.length === 0) {
            return;
        }

        try {
            await this.insertBatch(inputs);
        } catch (error) {
            if (!(error instanceof postgres.PostgresError)) {
                throw error;
            }

            if (this.isRefusal(error, inputs)) {
                throw InboxUpdateRefused.byPostgresError(error);
            }

            throw InboxPushFailed.byPostgresError(error);
        }
    }

    // onReady is called on the commit of every push or completion that leaves a group ready on any
    // node, and every time the listening starts: the first time and after a reconnect, since a
    // commit made while the connection was down is heard by no one. Resolves once the listening
    // starts. LISTEN takes a connection of its own, outside the pool, until Database.close()
    // (docs/architecture/storage.md).
    public async listenReady(onReady: () => void): Promise<void> {
        await this.sql.listen(InboxChannel.Ready, () => onReady(), onReady);
    }

    // One statement, so it is atomic without a transaction: up to limit ready groups, the head of
    // each, the groups that waited longest first (docs/architecture/inbox.md, "Claim"). The groups
    // are limited before their heads are looked up: a ready group always has a pending head, so the
    // order needs nothing from the head. A group locked by another claimer is skipped, not waited for. A claimed group moves behind the groups
    // that wait, so they are served in turn. The claimed groups are leased to the caller for
    // leaseDurationMs under the token of this claim. Each claimed update carries the start of its
    // attempt and the worker, which its completion writes.
    public async claim(limit: number, worker: InboxWorker): Promise<ClaimedInboxUpdate[]> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw InvalidClaimLimit.of(limit);
        }

        // One token per claim is enough: a group is leased to one claim at a time, and the token only
        // has to tell that claim from the next one of the same group.
        const lockToken = randomUUID();

        const claimedRows = await this.sql<ClaimedInboxRow[]>`
            WITH ready_groups AS (
                SELECT user_id, chat_id
                FROM telegram_inbox_groups
                WHERE state = ${InboxGroupState.Ready}
                  AND next_attempt_at <= now()
                ORDER BY next_attempt_at, user_id, chat_id
                LIMIT ${limit}::bigint
                FOR UPDATE SKIP LOCKED
            ),
            heads AS (
                SELECT head.update_id
                FROM ready_groups
                CROSS JOIN LATERAL (
                    SELECT update_id
                    FROM telegram_inbox
                    WHERE user_id = ready_groups.user_id
                      AND chat_id = ready_groups.chat_id
                      AND status IN ${this.sql(ACTIVE_STATUSES)}
                    ORDER BY update_id
                    LIMIT 1
                ) AS head
            ),
            claimed AS (
                -- The head comes from the snapshot of the statement (docs/architecture/inbox.md, "Claim").
                UPDATE telegram_inbox
                SET status = ${InboxStatus.Processing},
                    updated_at = now()
                FROM heads
                WHERE telegram_inbox.update_id = heads.update_id
                  AND telegram_inbox.status = ${InboxStatus.Pending}
                RETURNING telegram_inbox.update_id, telegram_inbox.user_id, telegram_inbox.chat_id, telegram_inbox.update,
                          -- As jsonb writes a timestamp: the attempt keeps the start in that form.
                          to_jsonb(now()) #>> '{}' AS started_at,
                          jsonb_array_length(telegram_inbox.attempts) AS earlier_attempts
            ),
            leased AS (
                UPDATE telegram_inbox_groups
                SET state = ${InboxGroupState.Processing},
                    next_attempt_at = now(),
                    locked_until = now() + ${this.leaseDurationMs}::double precision * interval '1 millisecond',
                    lock_token = ${lockToken},
                    updated_at = now()
                FROM claimed
                WHERE telegram_inbox_groups.user_id = claimed.user_id
                  AND telegram_inbox_groups.chat_id = claimed.chat_id
            )
            SELECT update_id, user_id, chat_id, update, started_at, earlier_attempts
            FROM claimed
            ORDER BY update_id
        `;

        return claimedRows.map((row) => ({
            updateId: Number(row.update_id),
            userId: Number(row.user_id),
            chatId: Number(row.chat_id),
            update: row.update,
            lockToken: lockToken,
            startedAt: row.started_at,
            worker: worker,
            earlierAttempts: row.earlier_attempts,
        }));
    }

    // The groups whose lease has passed, each with its processing update as a lease under the group's
    // token. The lease stays: a completion under that token takes the update back, fenced as any
    // completion, so a late completion of the node presumed dead and a second recovery of the same
    // lease change nothing (docs/architecture/inbox.md, "Lease recovery").
    public async findExpiredLeases(): Promise<ExpiredInboxLease[]> {
        const rows = await this.sql<ExpiredInboxLeaseRow[]>`
            SELECT inbox_update.update_id,
                   inbox_group.lock_token,
                   -- The start of the claim, in the form the claim gives it out: the claim sets
                   -- updated_at of the update it makes processing, and nothing else writes a
                   -- processing update. Not locked_until minus the lease duration: an extension
                   -- moves locked_until.
                   to_jsonb(inbox_update.updated_at) #>> '{}' AS started_at,
                   jsonb_array_length(inbox_update.attempts) AS earlier_attempts
            FROM telegram_inbox_groups AS inbox_group
            -- The first processing update of the group by update_id, so the lookup stops at it: the
            -- claim makes the head processing, and with no LIMIT the lookup read every active update
            -- of the group behind it (docs/architecture/inbox-load-test.md, "The lease recovery").
            -- Not the head alone, as the outbox takes it: an update pushed with a smaller update_id
            -- comes before the processing one (docs/architecture/inbox.md, "Lease recovery").
            CROSS JOIN LATERAL (
                SELECT update_id, updated_at, attempts
                FROM telegram_inbox
                WHERE user_id = inbox_group.user_id
                  AND chat_id = inbox_group.chat_id
                  AND status = ${InboxStatus.Processing}
                ORDER BY update_id
                LIMIT 1
            ) AS inbox_update
            -- Only a claimed group is leased: a completion clears the lease.
            WHERE inbox_group.locked_until <= now()
            ORDER BY inbox_group.locked_until, inbox_group.user_id, inbox_group.chat_id
        `;

        return rows.map((row) => ({
            updateId: Number(row.update_id),
            lockToken: row.lock_token,
            startedAt: row.started_at,
            worker: null,
            earlierAttempts: row.earlier_attempts,
        }));
    }

    // Moves the end of a claimed group's lease to now() plus the lease duration, so a handler that
    // runs longer than one lease keeps its group. Only a lease that has not passed, under the group's
    // own token: the recovery tells its lease by the token, so a lease extended after it passed would
    // let the recovery and the handler both complete the update (docs/architecture/inbox.md, "The
    // lease"). Returns whether the lease was extended; false means the update is no longer the
    // caller's to complete, or will not be once the recovery reaches it.
    public async extendLease(lease: InboxLease): Promise<boolean> {
        // now() is fixed at the start of the statement. The update may wait for the group row a push, a
        // fenced completion or a refused unblock holds; they only lock the row, so PostgreSQL does not
        // check it again after the wait: a lease that passes during the wait is still extended
        // (docs/architecture/inbox.md, "The lease"). An applied completion writes the row, and the
        // check of the token refuses the extension then.
        const extendedRows = await this.sql`
            UPDATE telegram_inbox_groups
            SET locked_until = now() + ${this.leaseDurationMs}::double precision * interval '1 millisecond',
                updated_at = now()
            WHERE (user_id, chat_id) = (SELECT user_id, chat_id FROM telegram_inbox WHERE update_id = ${lease.updateId})
              AND lock_token = ${lease.lockToken}
              AND locked_until > now()
            RETURNING user_id
        `;

        return extendedRows.length > 0;
    }

    // The update is handled, and its group goes on to its next update.
    public async markAsDone(lease: InboxLease): Promise<void> {
        await this.complete(lease, null, async (sql, group) => {
            await this.finishUpdate(sql, lease, InboxStatus.Done, null);
            await this.releaseGroup(sql, group);
        });
    }

    // The update goes back to pending, and its group waits delayMs: the update stays the head, so it
    // holds its group. The group is ready again, so the ready channel is notified on commit, as a push
    // does: a worker with nothing to claim learns of the group from nothing else. A retry with a
    // delay notifies too, before the group can be claimed, and the end of the delay notifies no one.
    // A fenced retry notifies no one.
    public async retry(lease: InboxLease, attemptError: InboxAttemptError, delayMs: number): Promise<void> {
        await this.complete(lease, attemptError, async (sql, group) => {
            await this.writeProcessingUpdateOrThrow(
                lease,
                sql`
                    UPDATE telegram_inbox
                    SET status = ${InboxStatus.Pending},
                        attempts = ${this.withAttempt(sql, lease, attemptError)},
                        updated_at = now()
                    WHERE update_id = ${lease.updateId}
                      AND status = ${InboxStatus.Processing}
                    RETURNING update_id
                `,
            );

            await this.setGroupState(sql, group, InboxGroupState.Ready);
            await sql`
                UPDATE telegram_inbox_groups
                SET next_attempt_at = now() + ${delayMs}::double precision * interval '1 millisecond',
                    updated_at = now()
                WHERE user_id = ${group.user_id}
                  AND chat_id = ${group.chat_id}
            `;

            await this.notifyReady(sql);
        });
    }

    // The update cannot be handled, and its group goes on to its next update.
    public async markAsFailed(lease: InboxLease, attemptError: InboxAttemptError): Promise<void> {
        await this.complete(lease, attemptError, async (sql, group) => {
            await this.finishUpdate(sql, lease, InboxStatus.Failed, attemptError);
            await this.releaseGroup(sql, group);
        });
    }

    // The update fails, and its group is blocked until it is unblocked by hand: the updates behind it
    // wait, new ones are still pushed.
    public async markAsFailedAndBlockGroup(lease: InboxLease, attemptError: InboxAttemptError): Promise<void> {
        const group = await this.complete(lease, attemptError, async (sql, lockedGroup) => {
            await this.finishUpdate(sql, lease, InboxStatus.Failed, attemptError);
            await this.setGroupState(sql, lockedGroup, InboxGroupState.Blocked);
        });

        // A fenced completion blocked nothing, so it logs no error: its failure is in the warning of
        // complete().
        if (group === null) {
            return;
        }

        this.logger.error("Inbox group is blocked by a failed update.", {
            userId: Number(group.user_id),
            chatId: Number(group.chat_id),
            updateId: lease.updateId,
            cause: attemptError,
        });
    }

    // Unblocks a group by hand: the failed update that blocked it goes back to pending, and its
    // update_id makes it the head again. Returns that update. A group that is not blocked throws
    // InboxGroupNotBlocked and changes nothing.
    public async retryBlockedGroup(groupKey: InboxGroupKey): Promise<number> {
        return this.sql.begin(async (sql) => {
            const blocked = await this.lockBlockedGroup(sql, groupKey);

            await sql`
                UPDATE telegram_inbox
                SET status = ${InboxStatus.Pending},
                    finished_at = NULL,
                    updated_at = now()
                WHERE update_id = ${blocked.updateId}
            `;

            // The head is pending, so the group has an active update: ready is right.
            await this.setGroupState(sql, blocked.group, InboxGroupState.Ready);
            await this.notifyReady(sql);

            return blocked.updateId;
        });
    }

    // Unblocks a group by hand: the failed update that blocked it becomes skipped, and the group goes
    // on with the update behind it, or goes idle when there is none. Returns the skipped update. A
    // group that is not blocked throws InboxGroupNotBlocked and changes nothing.
    public async skipBlockedGroup(groupKey: InboxGroupKey): Promise<number> {
        return this.sql.begin(async (sql) => {
            const blocked = await this.lockBlockedGroup(sql, groupKey);

            await sql`
                UPDATE telegram_inbox
                SET status = ${InboxStatus.Skipped},
                    finished_at = now(),
                    updated_at = now()
                WHERE update_id = ${blocked.updateId}
            `;

            // A ready group with no head would be claimed by nothing, so the state follows the active
            // updates left, read after the lock.
            await this.releaseGroup(sql, blocked.group);

            return blocked.updateId;
        });
    }

    // One batch of the done and skipped updates whose retention has passed since their end; the
    // number deleted. A caller that gets a full batch calls again. A failed update is never deleted:
    // it waits for a person. An update without finished_at is never deleted either.
    public async deleteFinishedUpdates(): Promise<number> {
        // finished_at plus the retention, not now() minus it: a long retention would take now()
        // below the earliest timestamp PostgreSQL has, 4713 BC, while the sum stays below its
        // latest for any retention the config takes.
        const deletedRows = await this.sql`
            DELETE FROM telegram_inbox
            WHERE update_id IN (
                SELECT update_id
                FROM telegram_inbox
                WHERE (status = ${InboxStatus.Done}
                       AND finished_at + ${this.cleanupSettings.doneRetentionMs}::double precision * interval '1 millisecond' < now())
                   OR (status = ${InboxStatus.Skipped}
                       AND finished_at + ${this.cleanupSettings.skippedRetentionMs}::double precision * interval '1 millisecond' < now())
                LIMIT ${this.cleanupSettings.batchSize}
                -- The lock rechecks the status on the newest version of the row, so an update moved
                -- back to pending meanwhile is kept; a row another cleanup holds is left to it.
                FOR UPDATE SKIP LOCKED
            )
            RETURNING update_id
        `;

        return deletedRows.length;
    }

    // One batch of the idle groups; the number deleted. A caller that gets a full batch calls again.
    // A group another transaction holds is skipped: a push or a completion is changing it. The lock
    // rechecks the state on the newest version of the row, so a group that a push has made ready
    // meanwhile is left alone too. A push that waits for a group the removal holds inserts it again
    // (docs/architecture/inbox.md, "Cleanup").
    public async deleteIdleGroups(): Promise<number> {
        const deletedRows = await this.sql`
            DELETE FROM telegram_inbox_groups
            WHERE (user_id, chat_id) IN (
                SELECT user_id, chat_id
                FROM telegram_inbox_groups
                WHERE state = ${InboxGroupState.Idle}
                LIMIT ${this.cleanupSettings.batchSize}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING user_id
        `;

        return deletedRows.length;
    }

    private async insertBatch(inputs: InboxUpdateInput[]): Promise<void> {
        const groups = this.uniqueGroups(inputs);
        const userIds = groups.map((group) => group.userId);
        const chatIds = groups.map((group) => group.chatId);

        await this.sql.begin(async (sql) => {
            // Inserts the group row or locks the one there, in one statement, as OutboxStore.pushBatch()
            // does with its chats. WHERE false is not a mistake: PostgreSQL locks the row before it
            // checks the condition, and the false one keeps the lock without writing a new version of
            // the row. The groups go in key order, so two batches lock the groups they share in the
            // same order; the update of the states below would take the locks in whatever order it
            // meets the rows, and two batches could deadlock.
            await sql`
                INSERT INTO telegram_inbox_groups (user_id, chat_id, state)
                SELECT user_id, chat_id, ${InboxGroupState.Idle}
                FROM unnest(${sql.array(userIds, BIGINT)}::bigint[], ${sql.array(chatIds, BIGINT)}::bigint[]) AS input(user_id, chat_id)
                ORDER BY user_id, chat_id
                ON CONFLICT (user_id, chat_id) DO UPDATE
                SET state = telegram_inbox_groups.state
                WHERE false
            `;

            // An idle group gets its first update, but only from an update inserted here: a group
            // whose updates were all stored already has no head to claim. A ready or processing group
            // already has an older head, and a blocked one stays blocked. The updates go as JSON text:
            // sql.json() takes only a type with an index signature, which grammY's Update interface
            // lacks, and it would send the same JSON.stringify() text. The parameter is text: one the
            // statement types as jsonb postgres.js passes through JSON.stringify() once more, into a
            // JSON string.
            const readyGroups = await sql`
                WITH inserted AS (
                    INSERT INTO telegram_inbox (update_id, user_id, chat_id, update, status)
                    SELECT (input -> 'update' ->> 'update_id')::bigint,
                           (input ->> 'userId')::bigint,
                           (input ->> 'chatId')::bigint,
                           input -> 'update',
                           ${InboxStatus.Pending}
                    FROM jsonb_array_elements(${JSON.stringify(inputs)}::text::jsonb) AS input
                    ON CONFLICT (update_id) DO NOTHING
                    RETURNING user_id, chat_id
                )
                UPDATE telegram_inbox_groups
                SET state = ${InboxGroupState.Ready},
                    updated_at = now()
                FROM (SELECT DISTINCT user_id, chat_id FROM inserted) AS inserted_group
                WHERE telegram_inbox_groups.user_id = inserted_group.user_id
                  AND telegram_inbox_groups.chat_id = inserted_group.chat_id
                  AND telegram_inbox_groups.state = ${InboxGroupState.Idle}
                RETURNING telegram_inbox_groups.user_id
            `;

            // A group that was ready or processing already has been claimed, or will be after the
            // completion that notifies; a redelivered batch made nothing ready and wakes no one.
            if (readyGroups.length > 0) {
                await this.notifyReady(sql);
            }
        });
    }

    // A failure the updates themselves cause: one of the refusal codes, and a value jsonb refuses in
    // one of the updates. 22P02 is the code of any malformed input, so a store change that broke every
    // row would give it too, and the code alone would drop every update.
    private isRefusal(error: postgres.PostgresError, inputs: InboxUpdateInput[]): boolean {
        if (!REFUSED_UPDATE_SQLSTATES.has(error.code)) {
            return false;
        }

        return inputs.some((input) => this.holdsValueJsonbRefuses(input.update));
    }

    // A string jsonb refuses anywhere in the value, a key included.
    private holdsValueJsonbRefuses(value: unknown): boolean {
        if (typeof value === "string") {
            return !isJsonbStorable(value);
        }

        if (typeof value !== "object" || value === null) {
            return false;
        }

        return Object.entries(value).some(([key, nested]) => !isJsonbStorable(key) || this.holdsValueJsonbRefuses(nested));
    }

    // Every completion: the lock of the group, then the fence, then the writes
    // (docs/architecture/inbox.md, "Completions"). A missing update throws InboxUpdateNotLeased. A lock
    // token that is not the group's changes nothing and is logged with the error the completion
    // carried: the lease has passed to another claim, or the group was released by an earlier
    // completion. A group row that is missing while its update is there changes nothing either and is
    // logged apart: deleteIdleGroups() removed the group once it went idle, so no lease is left.
    // Returns the group of an applied completion, null for a fenced one.
    private async complete(
        lease: InboxLease,
        attemptError: InboxAttemptError | null,
        write: (sql: TransactionSql, group: LockedInboxGroupRow) => Promise<void>,
    ): Promise<LockedInboxGroupRow | null> {
        return this.sql.begin(async (sql) => {
            // The lock reads the token of the row it locks in its newest committed version.
            const [group] = await sql<LockedInboxGroupRow[]>`
                SELECT user_id, chat_id, lock_token
                FROM telegram_inbox_groups
                WHERE (user_id, chat_id) = (SELECT user_id, chat_id FROM telegram_inbox WHERE update_id = ${lease.updateId})
                FOR UPDATE
            `;

            if (group === undefined) {
                if (!(await this.hasUpdate(sql, lease.updateId))) {
                    throw InboxUpdateNotLeased.byId(lease.updateId);
                }

                this.logger.warning("Inbox completion of a group the cleanup removed changed nothing.", {
                    updateId: lease.updateId,
                    lockToken: lease.lockToken,
                    cause: attemptError,
                });

                return null;
            }

            if (group.lock_token !== lease.lockToken) {
                // The token of the group tells a lease passed to another claim from one already
                // ended by a completion, which leaves null.
                this.logger.warning("Inbox completion with a stale lock token changed nothing.", {
                    updateId: lease.updateId,
                    lockToken: lease.lockToken,
                    userId: Number(group.user_id),
                    chatId: Number(group.chat_id),
                    groupLockToken: group.lock_token,
                    cause: attemptError,
                });

                return null;
            }

            await write(sql, group);

            return group;
        });
    }

    // The lock of a group to unblock, then its failed update that blocked it: the one that failed
    // last, since a blocked group is claimed no more. The state is read from the locked row, so a
    // group that a completion or another unblock changed while this call waited is seen as it is now.
    private async lockBlockedGroup(
        sql: TransactionSql,
        groupKey: InboxGroupKey,
    ): Promise<{ group: LockedInboxGroupRow; updateId: number }> {
        const [group] = await sql<(LockedInboxGroupRow & { state: string })[]>`
            SELECT user_id, chat_id, lock_token, state
            FROM telegram_inbox_groups
            WHERE user_id = ${groupKey.userId}
              AND chat_id = ${groupKey.chatId}
            FOR UPDATE
        `;

        if (group === undefined || group.state !== InboxGroupState.Blocked) {
            throw InboxGroupNotBlocked.byGroup(groupKey.userId, groupKey.chatId);
        }

        const [failedUpdate] = await sql<{ update_id: string }[]>`
            SELECT update_id
            FROM telegram_inbox
            WHERE user_id = ${group.user_id}
              AND chat_id = ${group.chat_id}
              AND status = ${InboxStatus.Failed}
            ORDER BY finished_at DESC, update_id DESC
            LIMIT 1
        `;

        // Only markAsFailedAndBlockGroup() blocks a group, in the transaction that fails the update,
        // and a failed update is never deleted: a group blocked without one was edited by hand.
        if (failedUpdate === undefined) {
            throw InboxGroupNotBlocked.byGroup(groupKey.userId, groupKey.chatId);
        }

        return { group: group, updateId: Number(failedUpdate.update_id) };
    }

    private async hasUpdate(sql: TransactionSql, updateId: number): Promise<boolean> {
        const [update] = await sql`SELECT update_id FROM telegram_inbox WHERE update_id = ${updateId}`;

        return update !== undefined;
    }

    // The final outcome of an update, with the end of its attempt. finished_at is for the cleanup.
    private async finishUpdate(
        sql: TransactionSql,
        lease: InboxLease,
        status: InboxStatus.Done | InboxStatus.Failed,
        attemptError: InboxAttemptError | null,
    ): Promise<void> {
        await this.writeProcessingUpdateOrThrow(
            lease,
            sql`
                UPDATE telegram_inbox
                SET status = ${status},
                    attempts = ${this.withAttempt(sql, lease, attemptError)},
                    finished_at = now(),
                    updated_at = now()
                WHERE update_id = ${lease.updateId}
                  AND status = ${InboxStatus.Processing}
                RETURNING update_id
            `,
        );
    }

    // The token is the group's, so the group is processing with one update: another update of the
    // group is a wrong id.
    private async writeProcessingUpdateOrThrow(lease: InboxLease, updateStatement: PendingQuery<Row[]>): Promise<void> {
        const [updated] = await updateStatement;

        if (updated === undefined) {
            throw InboxUpdateNotLeased.byId(lease.updateId);
        }
    }

    // The attempts with this one appended: its start and worker from the lease, its error, null for a
    // success, and its end by the database clock, as its start.
    private withAttempt(sql: TransactionSql, lease: InboxLease, attemptError: InboxAttemptError | null): PendingQuery<Row[]> {
        const { worker } = lease;
        const attempt: Omit<InboxAttempt, "finished_at"> = {
            started_at: lease.startedAt,
            worker: worker === null ? null : { host: worker.host, pid: worker.pid, worker_id: worker.workerId },
            error: attemptError,
        };

        return sql`attempts || jsonb_build_array(${sql.json(attempt)}::jsonb || jsonb_build_object('finished_at', now()))`;
    }

    // Wakes the workers that sleep with nothing to claim. Through sql of the transaction that made a
    // group ready, so PostgreSQL delivers it on commit, a worker that wakes up on it sees the group,
    // and a transaction that rolls back notifies no one. Not sql.notify() of postgres.js: it runs on
    // the pool whatever sql it is called on (OutboxStore.notifyFinished()). No group in it: the worker
    // takes what it claims, not what was pushed.
    private async notifyReady(sql: TransactionSql): Promise<void> {
        await sql`SELECT pg_notify(${InboxChannel.Ready}, '')`;
    }

    // The group goes on: ready while it has an update left, idle otherwise. The active updates are
    // read after the lock, so an update pushed meanwhile is seen. A ready group notifies the ready
    // channel: the update behind the finished one was pushed while the group was processing, and its
    // push woke no one.
    private async releaseGroup(sql: TransactionSql, group: LockedInboxGroupRow): Promise<void> {
        const [remainingUpdate] = await sql`
            SELECT update_id
            FROM telegram_inbox
            WHERE user_id = ${group.user_id}
              AND chat_id = ${group.chat_id}
              AND status IN ${sql(ACTIVE_STATUSES)}
            LIMIT 1
        `;

        if (remainingUpdate === undefined) {
            await this.setGroupState(sql, group, InboxGroupState.Idle);

            return;
        }

        await this.setGroupState(sql, group, InboxGroupState.Ready);
        await this.notifyReady(sql);
    }

    // The lease ends with the completion: a late completion of the same claim finds no token.
    private async setGroupState(sql: TransactionSql, group: LockedInboxGroupRow, state: InboxGroupState): Promise<void> {
        await sql`
            UPDATE telegram_inbox_groups
            SET state = ${state},
                locked_until = NULL,
                lock_token = NULL,
                updated_at = now()
            WHERE user_id = ${group.user_id}
              AND chat_id = ${group.chat_id}
        `;
    }

    // Each group of the batch once: a row inserted twice by one ON CONFLICT DO UPDATE statement fails it.
    private uniqueGroups(inputs: InboxUpdateInput[]): { userId: number; chatId: number }[] {
        const groupsByKey = new Map<string, { userId: number; chatId: number }>();

        for (const { userId, chatId } of inputs) {
            groupsByKey.set(`${userId}:${chatId}`, { userId: userId, chatId: chatId });
        }

        return [...groupsByKey.values()];
    }
}
