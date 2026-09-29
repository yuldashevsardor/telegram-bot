import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";
import type { PendingQuery, Row, TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type {
    OutboxAttempt,
    OutboxAttemptError,
    OutboxFinalOutcome,
    OutboxJson,
    OutboxLease,
    OutboxMessageInput,
    OutboxPullResult,
    OutboxPullResultRow,
    OutboxWorker,
} from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import { InvalidPauseDuration, OutboxMessageNotProcessing } from "app/telegram/outbox/store/outbox-store.errors";

// The OID of bigint: the chat ids go to the database as a bigint[] parameter.
const BIGINT = 20;

// The statuses a chat head can be in: its first message by id among them. A failed message is not
// among them: the chat it blocks is held by its state, and one that does not block lets the next
// message through.
const ACTIVE_STATUSES = [OutboxStatus.Pending, OutboxStatus.Processing];

// The single row of telegram_bot_limits.
const BOT_LIMITS_ID = 1;

// The longest pause PostgreSQL can still add to now(), some 285 000 years: 1e17 ms overflows the
// interval.
const MAX_PAUSE_MS = Number.MAX_SAFE_INTEGER;

// The rows and the chat states of the outbox: the model is in docs/architecture/outbox.md.
@injectable()
export class OutboxStore {
    private readonly sql: Sql;

    public constructor(
        @inject<Database>(Tokens.Platform.Database) database: Database,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly limits: TelegramLimits = configValue("limits"),
        private readonly leaseDurationMs: number = configValue("outbox.leaseDurationMs"),
    ) {
        this.sql = database.sql;
    }

    public async push(message: OutboxMessageInput): Promise<number> {
        const [id] = await this.pushBatch([message]);

        // One message in, one id out: the batch inserts every message it gets.
        return id as number;
    }

    // The rows and their chats commit together. The ids come back in the order of the input, which
    // is the order of the messages inside a chat. They are taken only once the chats are locked
    // (docs/architecture/outbox.md, "The chat lock").
    public async pushBatch(messages: OutboxMessageInput[]): Promise<number[]> {
        const chatIds = [...new Set(messages.map((message) => message.chatId))];

        return this.sql.begin(async (sql) => {
            // Both statements go in chat_id order, so two batches wait for the chats they share in
            // the same order.
            await sql`
                INSERT INTO telegram_outbox_chats (chat_id, state)
                SELECT chat_id, ${OutboxChatState.Idle}
                FROM unnest(${sql.array(chatIds, BIGINT)}::bigint[]) AS input(chat_id)
                ORDER BY chat_id
                ON CONFLICT (chat_id) DO NOTHING
            `;

            await sql`
                SELECT chat_id
                FROM telegram_outbox_chats
                WHERE chat_id = ANY(${sql.array(chatIds, BIGINT)}::bigint[])
                ORDER BY chat_id
                FOR UPDATE
            `;

            const rows = await sql<{ id: string }[]>`
                INSERT INTO telegram_outbox (chat_id, method, payload, priority, status)
                SELECT (message ->> 'chatId')::bigint,
                       message ->> 'method',
                       message -> 'payload',
                       (message ->> 'priority')::integer,
                       ${OutboxStatus.Pending}
                FROM jsonb_array_elements(${sql.json(messages)}) WITH ORDINALITY AS input(message, position)
                ORDER BY position
                RETURNING id
            `;

            // An idle chat gets its first message. A ready or processing chat already has an older
            // head, and a blocked one stays blocked.
            await sql`
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Ready},
                    updated_at = now()
                WHERE chat_id = ANY(${sql.array(chatIds, BIGINT)}::bigint[])
                  AND state = ${OutboxChatState.Idle}
            `;

            return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
        });
    }

    // One statement, so it is atomic without a transaction: up to limit ready chats by the priority
    // of their head, and the head of each, within the common limit, the chat limit and the pause
    // (docs/architecture/outbox.md, "Pull"). A chat locked by another puller is skipped, not waited
    // for, and so is the bot row: one puller at a time spends the common limit. A pulled chat moves
    // behind the chats of the same priority, so they are served in turn. The messages come back by
    // priority, so a caller that sends them in order sends the urgent first. The pulled chats are
    // leased to the caller for leaseDurationMs under the token of this pull, and each pulled message
    // gets an open attempt of the worker.
    public async pull(limit: number, worker: OutboxWorker): Promise<OutboxPullResult> {
        // One token per pull is enough: a chat is leased to one pull at a time, and the token only
        // has to tell that pull from the next one of the same chat.
        const lockToken = randomUUID();
        const commonLimit = this.limits.common;
        const commonCooldownMs = this.cooldownMs(commonLimit);

        const [row] = await this.sql<OutboxPullResultRow[]>`
            WITH bot AS (
                -- The slots of the common limit come due one per cooldown from next_send_at, and an
                -- idle bot saves up no more than number of them.
                SELECT least(
                           ${limit}::integer,
                           ${commonLimit.number}::integer,
                           floor(extract(epoch FROM now() - next_send_at) * ${MS_PER_SECOND} / ${commonCooldownMs}::double precision) + 1
                       )::integer AS budget
                FROM telegram_bot_limits
                WHERE id = ${BOT_LIMITS_ID}
                  AND next_send_at <= now()
                  AND (paused_until IS NULL OR paused_until <= now())
                  -- A pull with nothing to take leaves the row to the pulls that have something.
                  AND EXISTS (
                      SELECT 1
                      FROM telegram_outbox_chats
                      WHERE state = ${OutboxChatState.Ready}
                        AND next_attempt_at <= now()
                  )
                FOR UPDATE SKIP LOCKED
            ),
            heads AS (
                SELECT chats.chat_id, head.id
                FROM telegram_outbox_chats AS chats
                CROSS JOIN LATERAL (
                    SELECT id, priority
                    FROM telegram_outbox
                    WHERE chat_id = chats.chat_id
                      AND status IN ${this.sql(ACTIVE_STATUSES)}
                    ORDER BY id
                    LIMIT 1
                ) AS head
                WHERE chats.state = ${OutboxChatState.Ready}
                  AND chats.next_attempt_at <= now()
                ORDER BY head.priority, chats.next_attempt_at, chats.chat_id
                -- No bot row: a pause, a spent limit or another puller. NULL would lift the limit.
                LIMIT coalesce((SELECT budget FROM bot), 0)
                FOR UPDATE OF chats SKIP LOCKED
            ),
            pulled AS (
                -- The head comes from the snapshot of the statement (docs/architecture/outbox.md, "Pull").
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Processing},
                    attempts = attempts || jsonb_build_array(jsonb_build_object(
                        'started_at', now(),
                        'worker', ${this.sql.json({ host: worker.host, pid: worker.pid, worker_id: worker.workerId })}::jsonb,
                        'finished_at', NULL,
                        'error', NULL
                    )),
                    updated_at = now()
                FROM heads
                WHERE telegram_outbox.id = heads.id
                  AND telegram_outbox.status = ${OutboxStatus.Pending}
                RETURNING telegram_outbox.id, telegram_outbox.chat_id, method, payload, priority, attempts
            ),
            moved AS (
                -- A negative chat id is a group, as isGroupChat() has it.
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Processing},
                    next_attempt_at = now() + CASE
                        WHEN telegram_outbox_chats.chat_id < 0 THEN ${this.cooldownMs(this.limits.group)}::double precision
                        ELSE ${this.cooldownMs(this.limits.private)}::double precision
                    END * interval '1 millisecond',
                    locked_until = now() + ${this.leaseDurationMs}::double precision * interval '1 millisecond',
                    lock_token = ${lockToken},
                    updated_at = now()
                FROM pulled
                WHERE telegram_outbox_chats.chat_id = pulled.chat_id
            ),
            spent AS (
                -- From now(), not from the slots saved up: a batch holds the next one back by a
                -- cooldown per message, so no interval gets more than number messages.
                UPDATE telegram_bot_limits
                SET next_send_at = now() + (SELECT count(*) FROM pulled) * ${commonCooldownMs}::double precision * interval '1 millisecond',
                    updated_at = now()
                WHERE id = ${BOT_LIMITS_ID}
                  AND EXISTS (SELECT 1 FROM pulled)
                RETURNING next_send_at
            ),
            -- The row as it is after this pull; the snapshot when nothing was pulled.
            bot_after AS (
                SELECT coalesce((SELECT next_send_at FROM spent), next_send_at) AS next_send_at, paused_until
                FROM telegram_bot_limits
                WHERE id = ${BOT_LIMITS_ID}
            ),
            -- The chats pulled here are processing now; the rest of the ready ones wait for their time.
            ready AS (
                SELECT min(next_attempt_at) AS ready_at
                FROM telegram_outbox_chats
                WHERE state = ${OutboxChatState.Ready}
                  AND chat_id NOT IN (SELECT chat_id FROM pulled)
            )
            SELECT (
                       SELECT coalesce(
                           jsonb_agg(to_jsonb(pulled) ORDER BY priority, id),
                           '[]'::jsonb
                       )
                       FROM pulled
                   ) AS messages,
                   (
                       -- greatest() skips a NULL paused_until.
                       SELECT ceil(greatest(extract(epoch FROM greatest(ready.ready_at, bot_after.next_send_at, bot_after.paused_until) - now()) * ${MS_PER_SECOND}, 0))::double precision
                       FROM ready
                       CROSS JOIN bot_after
                       WHERE ready.ready_at IS NOT NULL
                   ) AS next_pull_in_ms
        `;

        // A statement without FROM returns exactly one row.
        const pullRow = row as OutboxPullResultRow;

        return {
            messages: pullRow.messages.map((message) => ({
                id: message.id,
                chatId: message.chat_id,
                method: message.method,
                payload: message.payload,
                priority: message.priority,
                lockToken: lockToken,
                attempts: message.attempts,
            })),
            nextPullInMs: pullRow.next_pull_in_ms,
        };
    }

    // Stops the pull on every node until now() + durationMs by the database clock. A pause is never
    // shortened: a 429 that asks for less than the pause left changes nothing. The common limit
    // starts over from the end of the pause, so the pull does not resume with a burst of saved slots.
    // An infinite duration would stop the outbox for good, and greatest() would keep it.
    public async pause(durationMs: number): Promise<void> {
        // NaN passes both comparisons, so it needs isNaN(); an infinity fails one of them.
        if (Number.isNaN(durationMs) || durationMs < 0 || durationMs > MAX_PAUSE_MS) {
            throw InvalidPauseDuration.of(durationMs);
        }

        await this.sql`
            UPDATE telegram_bot_limits
            SET paused_until = greatest(paused_until, pause.ends_at),
                next_send_at = greatest(next_send_at, paused_until, pause.ends_at),
                updated_at = now()
            FROM (SELECT now() + ${durationMs}::double precision * interval '1 millisecond' AS ends_at) AS pause
            WHERE id = ${BOT_LIMITS_ID}
        `;
    }

    // The time a limit leaves between two messages, as the in-memory queue spaces them. LIMIT_*_NUMBER
    // is at least 1, so the cooldown is finite.
    private cooldownMs(limit: TelegramLimits["common"]): number {
        return limit.interval / limit.number;
    }

    // The message is sent: the response goes to the row, and the chat goes on to its next message.
    public async markAsDone(lease: OutboxLease, response: OutboxJson): Promise<void> {
        await this.complete(lease, null, async (sql, chatId) => {
            await this.finishMessage(sql, lease, { status: OutboxStatus.Done, attemptError: null, response: response });
            await this.releaseChat(sql, chatId);
        });
    }

    // The message goes back to pending, and its chat waits delayMs or its chat limit, whichever is
    // later: the message stays the head, so it holds its chat.
    public async retry(lease: OutboxLease, attemptError: OutboxAttemptError, delayMs: number): Promise<void> {
        await this.complete(lease, attemptError, async (sql, chatId) => {
            await this.updateProcessingMessage(
                lease,
                sql`
                    UPDATE telegram_outbox
                    SET status = ${OutboxStatus.Pending},
                        attempts = ${this.closedAttempts(sql, lease, attemptError)},
                        updated_at = now()
                    WHERE id = ${lease.id}
                      AND status = ${OutboxStatus.Processing}
                    RETURNING id
                `,
            );

            await this.setChatState(sql, chatId, OutboxChatState.Ready);
            await sql`
                UPDATE telegram_outbox_chats
                SET next_attempt_at = greatest(next_attempt_at, now() + ${delayMs}::double precision * interval '1 millisecond'),
                    updated_at = now()
                WHERE chat_id = ${chatId}
            `;
        });
    }

    // The message cannot be delivered, and its chat goes on to its next message.
    public async markAsFailed(lease: OutboxLease, attemptError: OutboxAttemptError): Promise<void> {
        await this.complete(lease, attemptError, async (sql, chatId) => {
            await this.finishMessage(sql, lease, { status: OutboxStatus.Failed, attemptError: attemptError, response: null });
            await this.releaseChat(sql, chatId);
        });
    }

    // The message fails, and its chat is blocked until it is unblocked by hand: the messages behind
    // it wait, new ones are still pushed.
    public async markAsFailedAndBlockChat(lease: OutboxLease, attemptError: OutboxAttemptError): Promise<void> {
        const chatId = await this.complete(lease, attemptError, async (sql, lockedChatId) => {
            await this.finishMessage(sql, lease, { status: OutboxStatus.Failed, attemptError: attemptError, response: null });
            await this.setChatState(sql, lockedChatId, OutboxChatState.Blocked);
        });

        if (chatId === null) {
            return;
        }

        this.logger.error("Outbox chat is blocked by a failed message.", {
            chatId: Number(chatId),
            messageId: lease.id,
            cause: attemptError,
        });
    }

    // Every completion: the lock of the chat, then the fence, then the writes (docs/architecture/outbox.md,
    // "The chat lock"). A missing message throws OutboxMessageNotProcessing. A lock token that is not
    // the chat's changes nothing and is logged with the error the completion carried: the lease has
    // passed to another pull, or the chat was released by an earlier completion. Returns the chat of
    // an applied completion, null for a fenced one.
    private async complete(
        lease: OutboxLease,
        attemptError: OutboxAttemptError | null,
        write: (sql: TransactionSql, chatId: string) => Promise<void>,
    ): Promise<string | null> {
        return this.sql.begin(async (sql) => {
            // The lock reads the token of the row it locks in its newest committed version.
            const [chat] = await sql<{ chat_id: string; lock_token: string | null }[]>`
                SELECT chat_id, lock_token
                FROM telegram_outbox_chats
                WHERE chat_id = (SELECT chat_id FROM telegram_outbox WHERE id = ${lease.id})
                FOR UPDATE
            `;

            if (chat === undefined) {
                throw OutboxMessageNotProcessing.byId(lease.id);
            }

            if (chat.lock_token !== lease.lockToken) {
                this.logger.warning("Outbox completion with a stale lock token changed nothing.", {
                    messageId: lease.id,
                    lockToken: lease.lockToken,
                    cause: attemptError,
                });

                return null;
            }

            await write(sql, chat.chat_id);

            return chat.chat_id;
        });
    }

    // The final outcome of a message, with the end of its attempt. finished_at is for the cleanup.
    private async finishMessage(sql: TransactionSql, lease: OutboxLease, outcome: OutboxFinalOutcome): Promise<void> {
        const { status, attemptError, response } = outcome;

        await this.updateProcessingMessage(
            lease,
            sql`
                UPDATE telegram_outbox
                SET status = ${status},
                    attempts = ${this.closedAttempts(sql, lease, attemptError)},
                    response = ${response === null ? null : sql.json(response)},
                    finished_at = now(),
                    updated_at = now()
                WHERE id = ${lease.id}
                  AND status = ${OutboxStatus.Processing}
                RETURNING id
            `,
        );
    }

    // The token is the chat's, so the chat is processing with one message: another message of the
    // chat is a wrong id.
    private async updateProcessingMessage(lease: OutboxLease, update: PendingQuery<Row[]>): Promise<void> {
        const [updated] = await update;

        if (updated === undefined) {
            throw OutboxMessageNotProcessing.byId(lease.id);
        }
    }

    // The attempts of the lease with the last one, opened by the pull, closed with the error, null for
    // a success. The attempts of the lease are the stored ones: only the holder of the lease writes
    // them. finished_at alone is set in SQL, since the outbox goes by the database clock
    // (docs/architecture/invariants.md, "The outbox").
    private closedAttempts(sql: TransactionSql, lease: OutboxLease, attemptError: OutboxAttemptError | null): PendingQuery<Row[]> {
        const earlierAttempts = lease.attempts.slice(0, -1);
        // The pull opened it, so a pulled message has at least one attempt.
        const openAttempt = lease.attempts[lease.attempts.length - 1] as OutboxAttempt;
        const attempts: OutboxAttempt[] = [...earlierAttempts, { ...openAttempt, error: attemptError }];

        // A serialized error types its cause as unknown, which sql.json() does not take, so the
        // attempts go as JSON text. The text cast keeps postgres from encoding that text once more.
        return sql`jsonb_set(${JSON.stringify(attempts)}::text::jsonb, '{-1,finished_at}', to_jsonb(now()))`;
    }

    // The chat goes on: ready while it has a message left, idle otherwise. The active messages are
    // read after the lock, so a message pushed meanwhile is seen.
    private async releaseChat(sql: TransactionSql, chatId: string): Promise<void> {
        const [remainingMessage] = await sql`
            SELECT id
            FROM telegram_outbox
            WHERE chat_id = ${chatId}
              AND status IN ${sql(ACTIVE_STATUSES)}
            LIMIT 1
        `;

        await this.setChatState(sql, chatId, remainingMessage === undefined ? OutboxChatState.Idle : OutboxChatState.Ready);
    }

    // The lease ends with the completion: a late completion of the same pull finds no token.
    private async setChatState(sql: TransactionSql, chatId: string, state: OutboxChatState): Promise<void> {
        await sql`
            UPDATE telegram_outbox_chats
            SET state = ${state},
                locked_until = NULL,
                lock_token = NULL,
                updated_at = now()
            WHERE chat_id = ${chatId}
        `;
    }
}
