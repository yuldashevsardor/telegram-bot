import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";
import type { PendingQuery, Row, TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type {
    ClaimedInboxRow,
    ClaimedInboxUpdate,
    ExpiredInboxLease,
    ExpiredInboxLeaseRow,
    InboxAttempt,
    InboxAttemptError,
    InboxLease,
    InboxUpdateInput,
    InboxWorker,
    LockedInboxGroupRow,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { InboxUpdateNotLeased, InvalidClaimLimit } from "app/telegram/inbox/store/inbox-store.errors";

// The OID of bigint: the user and chat ids of the groups go to the database as bigint[] parameters.
const BIGINT = 20;

// The statuses a group head can be in: its first update by update_id among them. A failed update is
// not among them: the group it blocks is held by its state, and one that does not block lets the
// next update through.
const ACTIVE_STATUSES = [InboxStatus.Pending, InboxStatus.Processing];

// The rows and the group states of the inbox: the model is in docs/architecture/inbox.md.
@injectable()
export class InboxStore {
    private readonly sql: Sql;

    public constructor(
        @inject<Database>(Tokens.Platform.Database) database: Database,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly leaseDurationMs: number = configValue("inbox.leaseDurationMs"),
    ) {
        this.sql = database.sql;
    }

    public async push(input: InboxUpdateInput): Promise<void> {
        await this.pushBatch([input]);
    }

    // The updates and their groups commit together. An update whose update_id is stored already is
    // left out: Telegram delivers an update again when it did not learn that the bot got it
    // (docs/architecture/inbox.md, "Push").
    public async pushBatch(inputs: InboxUpdateInput[]): Promise<void> {
        // An empty getUpdates is the common answer of a poll: it costs no transaction.
        if (inputs.length === 0) {
            return;
        }

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
            await sql`
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
            `;
        });
    }

    // One statement, so it is atomic without a transaction: up to limit ready groups, the head of
    // each, the groups that waited longest first (docs/architecture/inbox.md, "Claim"). A group
    // locked by another claimer is skipped, not waited for. A claimed group moves behind the groups
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
            WITH heads AS (
                SELECT head.update_id
                FROM telegram_inbox_groups AS inbox_group
                CROSS JOIN LATERAL (
                    SELECT update_id
                    FROM telegram_inbox
                    WHERE user_id = inbox_group.user_id
                      AND chat_id = inbox_group.chat_id
                      AND status IN ${this.sql(ACTIVE_STATUSES)}
                    ORDER BY update_id
                    LIMIT 1
                ) AS head
                WHERE inbox_group.state = ${InboxGroupState.Ready}
                  AND inbox_group.next_attempt_at <= now()
                ORDER BY inbox_group.next_attempt_at, inbox_group.user_id, inbox_group.chat_id
                LIMIT ${limit}::bigint
                FOR UPDATE OF inbox_group SKIP LOCKED
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
                   -- The start of the claim, in the form the claim gives it out.
                   to_jsonb(inbox_group.locked_until - ${this.leaseDurationMs}::double precision * interval '1 millisecond') #>> '{}' AS started_at,
                   jsonb_array_length(inbox_update.attempts) AS earlier_attempts
            FROM telegram_inbox_groups AS inbox_group
            JOIN telegram_inbox AS inbox_update
                ON inbox_update.user_id = inbox_group.user_id
               AND inbox_update.chat_id = inbox_group.chat_id
               AND inbox_update.status = ${InboxStatus.Processing}
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

    // The update is handled, and its group goes on to its next update.
    public async markAsDone(lease: InboxLease): Promise<void> {
        await this.complete(lease, null, async (sql, group) => {
            await this.finishUpdate(sql, lease, InboxStatus.Done, null);
            await this.releaseGroup(sql, group);
        });
    }

    // The update goes back to pending, and its group waits delayMs: the update stays the head, so it
    // holds its group.
    public async retry(lease: InboxLease, attemptError: InboxAttemptError, delayMs: number): Promise<void> {
        await this.complete(lease, attemptError, async (sql, group) => {
            await this.updateProcessingUpdate(
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

    // Every completion: the lock of the group, then the fence, then the writes
    // (docs/architecture/inbox.md, "Completions"). A missing update throws InboxUpdateNotLeased. A lock
    // token that is not the group's changes nothing and is logged with the error the completion
    // carried: the lease has passed to another claim, or the group was released by an earlier
    // completion. Returns the group of an applied completion, null for a fenced one.
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

            // A stored update always has its group row: nothing deletes one.
            if (group === undefined) {
                throw InboxUpdateNotLeased.byId(lease.updateId);
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

    // The final outcome of an update, with the end of its attempt. finished_at is for the cleanup.
    private async finishUpdate(
        sql: TransactionSql,
        lease: InboxLease,
        status: InboxStatus.Done | InboxStatus.Failed,
        attemptError: InboxAttemptError | null,
    ): Promise<void> {
        await this.updateProcessingUpdate(
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
    private async updateProcessingUpdate(lease: InboxLease, update: PendingQuery<Row[]>): Promise<void> {
        const [updated] = await update;

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

    // The group goes on: ready while it has an update left, idle otherwise. The active updates are
    // read after the lock, so an update pushed meanwhile is seen.
    private async releaseGroup(sql: TransactionSql, group: LockedInboxGroupRow): Promise<void> {
        const [remainingUpdate] = await sql`
            SELECT update_id
            FROM telegram_inbox
            WHERE user_id = ${group.user_id}
              AND chat_id = ${group.chat_id}
              AND status IN ${sql(ACTIVE_STATUSES)}
            LIMIT 1
        `;

        await this.setGroupState(sql, group, remainingUpdate === undefined ? InboxGroupState.Idle : InboxGroupState.Ready);
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
