import { inject, injectable } from "inversify";
import type { TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import type { TelegramLimits } from "app/bootstrap/config/config-values";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type {
    FinishedOutboxMessage,
    FinishedOutboxRow,
    OutboxJson,
    OutboxMessageInput,
    OutboxPullResult,
    OutboxPullResultRow,
} from "app/telegram/outbox/store/outbox-store.types";
import { FINISHED_STATUSES, OutboxChannel, OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import type { FinishedMessageSource } from "app/telegram/outbox/result-waiter/outbox-result-waiter.types";
import {
    BotLimitsRowMissing,
    InvalidPauseDuration,
    InvalidPullLimit,
    OutboxMessageNotProcessing,
} from "app/telegram/outbox/store/outbox-store.errors";

// The OID of bigint: the chat ids go to the database as a bigint[] parameter.
const BIGINT = 20;

// The statuses a chat head can be in: its first message by id among them.
const ACTIVE_STATUSES = [OutboxStatus.Pending, OutboxStatus.Processing, OutboxStatus.Failed];

// The single row of telegram_bot_limits.
const BOT_LIMITS_ID = 1;

// The longest pause PostgreSQL can still add to now(), some 285 000 years: 1e17 ms overflows the
// interval.
const MAX_PAUSE_MS = Number.MAX_SAFE_INTEGER;

// The rows and the chat states of the outbox: the model is in docs/architecture/outbox.md.
@injectable()
export class OutboxStore implements FinishedMessageSource {
    private readonly sql: Sql;

    public constructor(
        @inject<Database>(Tokens.Platform.Database) database: Database,
        private readonly limits: TelegramLimits = configValue("limits"),
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

            // An idle chat gets its first message; a chat in any other state already has an older head.
            await sql`
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Ready},
                    updated_at = now()
                WHERE chat_id = ANY(${sql.array(chatIds, BIGINT)}::bigint[])
                  AND state = ${OutboxChatState.Idle}
            `;

            // Delivered on commit, so a sender that wakes up on it sees the rows.
            await sql`SELECT pg_notify(${OutboxChannel.Ready}, '')`;

            return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
        });
    }

    // One statement, so it is atomic without a transaction: up to limit ready chats by the priority
    // of their head, and the head of each, within the common limit, the chat limit and the pause
    // (docs/architecture/outbox.md, "Pull"). A chat locked by another puller is skipped, not waited
    // for, and so is the bot row: one puller at a time spends the common limit. A pulled chat moves
    // behind the chats of the same priority, so they are served in turn. The messages come back by
    // priority, so a caller that sends them in order sends the urgent first.
    public async pull(limit: number): Promise<OutboxPullResult> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw InvalidPullLimit.of(limit);
        }

        const commonLimit = this.limits.common;
        const commonCooldownMs = this.cooldownMs(commonLimit);

        const pullRows = await this.sql<OutboxPullResultRow[]>`
            WITH bot AS (
                -- The slots of the common limit come due one per cooldown from next_send_at, and an
                -- idle bot saves up no more than number of them. The config bounds number only from
                -- below, so it is not cast to integer, which overflows above 2^31 - 1. The budget is at
                -- most limit, which fits a bigint.
                SELECT least(
                           ${limit}::bigint,
                           ${commonLimit.number}::double precision,
                           floor(extract(epoch FROM now() - next_send_at) * ${MS_PER_SECOND} / ${commonCooldownMs}::double precision) + 1
                       )::bigint AS budget
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
                    updated_at = now()
                FROM heads
                WHERE telegram_outbox.id = heads.id
                  AND telegram_outbox.status = ${OutboxStatus.Pending}
                RETURNING telegram_outbox.id, telegram_outbox.chat_id, method, payload, priority
            ),
            moved AS (
                -- A negative chat id is a group, as isGroupChat() has it.
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Processing},
                    next_attempt_at = now() + CASE
                        WHEN telegram_outbox_chats.chat_id < 0 THEN ${this.cooldownMs(this.limits.group)}::double precision
                        ELSE ${this.cooldownMs(this.limits.private)}::double precision
                    END * interval '1 millisecond',
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
                   ) AS next_pull_in_ms,
                   EXISTS (SELECT 1 FROM bot_after) AS has_bot_limits
        `;

        // A statement without FROM returns exactly one row.
        const pullRow = pullRows[0] as OutboxPullResultRow;

        // Without the row nothing is pulled and nextPullInMs is null, as if no chat were ready.
        if (!pullRow.has_bot_limits) {
            throw BotLimitsRowMissing.create();
        }

        return {
            messages: pullRow.messages.map((message) => ({
                id: message.id,
                chatId: message.chat_id,
                method: message.method,
                payload: message.payload,
                priority: message.priority,
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

        const [updatedRow] = await this.sql`
            UPDATE telegram_bot_limits
            SET paused_until = greatest(paused_until, pause.ends_at),
                next_send_at = greatest(next_send_at, paused_until, pause.ends_at),
                updated_at = now()
            FROM (SELECT now() + ${durationMs}::double precision * interval '1 millisecond' AS ends_at) AS pause
            WHERE id = ${BOT_LIMITS_ID}
            RETURNING id
        `;

        if (updatedRow === undefined) {
            throw BotLimitsRowMissing.create();
        }
    }

    // The time a limit leaves between two messages, as the in-memory queue spaces them. LIMIT_*_NUMBER
    // is at least 1, so the cooldown is finite.
    private cooldownMs(limit: TelegramLimits[keyof TelegramLimits]): number {
        return limit.interval / limit.number;
    }

    // messageId is telegram_outbox.id. A message that is missing or not processing throws
    // OutboxMessageNotProcessing, and nothing changes. The statements are separate on purpose
    // (docs/architecture/outbox.md, "The chat lock").
    public async markAsDone(messageId: number, response: OutboxJson): Promise<void> {
        await this.sql.begin(async (sql) => {
            const [chat] = await sql`
                SELECT chat_id
                FROM telegram_outbox_chats
                WHERE chat_id = (SELECT chat_id FROM telegram_outbox WHERE id = ${messageId})
                FOR UPDATE
            `;

            if (chat === undefined) {
                throw OutboxMessageNotProcessing.byId(messageId);
            }

            const [done] = await sql<{ chat_id: string }[]>`
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Done},
                    response = ${sql.json(response)},
                    finished_at = now(),
                    updated_at = now()
                WHERE id = ${messageId}
                  AND status = ${OutboxStatus.Processing}
                RETURNING chat_id
            `;

            if (done === undefined) {
                throw OutboxMessageNotProcessing.byId(messageId);
            }

            const [remainingMessage] = await sql`
                SELECT id
                FROM telegram_outbox
                WHERE chat_id = ${done.chat_id}
                  AND status IN ${sql(ACTIVE_STATUSES)}
                LIMIT 1
            `;

            await sql`
                UPDATE telegram_outbox_chats
                SET state = ${remainingMessage === undefined ? OutboxChatState.Idle : OutboxChatState.Ready},
                    updated_at = now()
                WHERE chat_id = ${done.chat_id}
            `;

            await this.notifyFinished(sql, messageId);
        });
    }

    public async findFinished(messageIds: number[]): Promise<FinishedOutboxMessage[]> {
        // The ids go as one jsonb array, not sql.array() as in pushBatch(): postgres.js takes the OID
        // of an array type from the types it loads on connecting. As the first query of a new client,
        // which the first poll of the waiter often is, sql.array() here failed with "cannot cast type
        // bigint to bigint[]"; pushBatch() in its transaction did not. Nor a list of parameters: every
        // number of ids would be a text of its own, and a prepared statement of its own on every
        // connection.
        const rows = await this.sql<FinishedOutboxRow[]>`
            SELECT id, status, response
            FROM telegram_outbox
            WHERE id IN (SELECT jsonb_array_elements_text(${this.sql.json(messageIds)})::bigint)
              AND status IN ${this.sql(FINISHED_STATUSES)}
        `;

        return rows.map((row) => ({ id: Number(row.id), status: row.status, response: row.response }));
    }

    // LISTEN takes a connection of its own, outside the pool, until Database.close()
    // (docs/architecture/storage.md).
    public async listenForFinished(onFinished: (messageId: number) => void, onListen: () => void): Promise<void> {
        await this.sql.listen(OutboxChannel.Finished, (payload) => onFinished(Number(payload)), onListen);
    }

    // Every transaction that moves a message into a final status calls it: a caller waiting on
    // another node learns of the outcome only from the poll otherwise (docs/architecture/invariants.md).
    // Delivered on commit, so the waiter that reads the row on it sees the outcome.
    private async notifyFinished(sql: TransactionSql, messageId: number): Promise<void> {
        await sql`SELECT pg_notify(${OutboxChannel.Finished}, ${String(messageId)})`;
    }
}
