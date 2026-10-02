import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";
import type { TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type {
    ClaimedInboxRow,
    ClaimedInboxUpdate,
    InboxLease,
    InboxUpdateInput,
    LockedInboxGroupRow,
} from "app/telegram/inbox/store/inbox-store.types";
import { InboxGroupState, InboxStatus } from "app/telegram/inbox/store/inbox-store.types";
import { InboxUpdateNotLeased, InvalidClaimLimit } from "app/telegram/inbox/store/inbox-store.errors";

// The OID of bigint: the user and chat ids of the groups go to the database as bigint[] parameters.
const BIGINT = 20;

// The statuses a group head can be in: its first update by update_id among them.
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
    // leaseDurationMs under the token of this claim.
    public async claim(limit: number): Promise<ClaimedInboxUpdate[]> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw InvalidClaimLimit.of(limit);
        }

        // One token per claim is enough: a group is leased to one claim at a time, and the token only
        // has to tell that claim from the next one of the same group.
        const lockToken = randomUUID();

        const rows = await this.sql<ClaimedInboxRow[]>`
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
                RETURNING telegram_inbox.update_id, telegram_inbox.user_id, telegram_inbox.chat_id, telegram_inbox.update
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
            SELECT update_id, user_id, chat_id, update
            FROM claimed
            ORDER BY update_id
        `;

        return rows.map((row) => ({
            updateId: Number(row.update_id),
            userId: Number(row.user_id),
            chatId: Number(row.chat_id),
            update: row.update,
            lockToken: lockToken,
        }));
    }

    // The update is handled, and its group goes on to its next update. A lock token that is not the
    // group's changes nothing and is logged: the lease has passed to another claim, or the group was
    // released by an earlier completion (docs/architecture/inbox.md, "Completion").
    public async markAsDone(lease: InboxLease): Promise<void> {
        await this.sql.begin(async (sql) => {
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
                this.logger.warning("Inbox completion with a stale lock token changed nothing.", {
                    updateId: lease.updateId,
                    lockToken: lease.lockToken,
                });

                return;
            }

            // The token is the group's, so the group is processing with one update: another update of
            // the group is a wrong id.
            const [doneRow] = await sql`
                UPDATE telegram_inbox
                SET status = ${InboxStatus.Done},
                    finished_at = now(),
                    updated_at = now()
                WHERE update_id = ${lease.updateId}
                  AND status = ${InboxStatus.Processing}
                RETURNING update_id
            `;

            if (doneRow === undefined) {
                throw InboxUpdateNotLeased.byId(lease.updateId);
            }

            await this.releaseGroup(sql, group);
        });
    }

    // The group goes on: ready while it has an update left, idle otherwise; the lease ends, so a late
    // completion of the same claim finds no token. The active updates are read after the lock, so an
    // update pushed meanwhile is seen.
    private async releaseGroup(sql: TransactionSql, group: LockedInboxGroupRow): Promise<void> {
        const [remainingUpdate] = await sql`
            SELECT update_id
            FROM telegram_inbox
            WHERE user_id = ${group.user_id}
              AND chat_id = ${group.chat_id}
              AND status IN ${sql(ACTIVE_STATUSES)}
            LIMIT 1
        `;

        await sql`
            UPDATE telegram_inbox_groups
            SET state = ${remainingUpdate === undefined ? InboxGroupState.Idle : InboxGroupState.Ready},
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
