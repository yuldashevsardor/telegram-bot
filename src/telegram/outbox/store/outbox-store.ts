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
    ExpiredOutboxLease,
    ExpiredOutboxLeaseRow,
    OutboxAttempt,
    OutboxAttemptError,
    OutboxBacklog,
    OutboxBacklogRow,
    OutboxCleanupSettings,
    OutboxFinalOutcome,
    OutboxJson,
    OutboxLease,
    OutboxMessageInput,
    OutboxPullResult,
    OutboxPullResultRow,
    OutboxWorker,
} from "app/telegram/outbox/store/outbox-store.types";
import { OutboxChannel, OutboxChatState, OutboxStatus } from "app/telegram/outbox/store/outbox-store.types";
import {
    BotLimitsRowMissing,
    InvalidPauseDuration,
    InvalidPullLimit,
    OutboxChatNotBlocked,
    OutboxMessageNotLeased,
} from "app/telegram/outbox/store/outbox-store.errors";

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
        private readonly cleanupSettings: OutboxCleanupSettings = configValue("outbox.cleanup"),
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
            // Inserts the chat row or locks the one there, in one statement: with DO NOTHING and a
            // separate lock, deleteIdleChats() could remove an idle chat between the two, and the
            // messages would go in without their chat row, never to be pulled. WHERE false is not a
            // mistake: PostgreSQL locks the row before it checks the condition, and the false one
            // keeps the lock without writing a new version of the row (the ON CONFLICT condition in
            // the docs of INSERT). The rows go in chat_id order, so two batches wait for the chats
            // they share in the same order.
            await sql`
                INSERT INTO telegram_outbox_chats (chat_id, state)
                SELECT chat_id, ${OutboxChatState.Idle}
                FROM unnest(${sql.array(chatIds, BIGINT)}::bigint[]) AS input(chat_id)
                ORDER BY chat_id
                ON CONFLICT (chat_id) DO UPDATE
                SET state = telegram_outbox_chats.state
                WHERE false
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

            await this.notifyReady(sql);

            return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
        });
    }

    // onReady is called on the commit of every push on any node, and every time the listening
    // starts: the first time and after a reconnect, since a push committed while the connection was
    // down is heard by no one. Resolves once the listening starts. LISTEN takes a connection of its
    // own, outside the pool, until Database.close() (docs/architecture/storage.md).
    public async listenReady(onReady: () => void): Promise<void> {
        await this.sql.listen(OutboxChannel.Ready, () => onReady(), onReady);
    }

    // One statement, so it is atomic without a transaction: up to limit ready chats by the priority
    // of their head, and the head of each, within the common limit, the chat limit and the pause
    // (docs/architecture/outbox.md, "Pull"). A chat locked by another puller is skipped, not waited
    // for; the bot row is waited for: one puller at a time spends the common limit. A pulled chat
    // moves behind the chats of the same priority, so they are served in turn. The messages come
    // back by priority, so a caller that sends them in order sends the urgent first. The pulled
    // chats are leased to the caller for leaseDurationMs under the token of this pull. Each pulled
    // message carries the start of its attempt and the worker, which its completion writes.
    public async pull(limit: number, worker: OutboxWorker): Promise<OutboxPullResult> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw InvalidPullLimit.of(limit);
        }

        // One token per pull is enough: a chat is leased to one pull at a time, and the token only
        // has to tell that pull from the next one of the same chat.
        const lockToken = randomUUID();
        const commonLimit = this.limits.common;
        const commonCooldownMs = this.cooldownMs(commonLimit);

        const pullRows = await this.sql<OutboxPullResultRow[]>`
            WITH bot AS (
                -- Waits for another pull or a pause holding the row and gets its newest version. The
                -- WHERE has nothing they change: the lock rechecks it on that version, and a row that
                -- failed it would leave the rest of the statement with the snapshot from before the
                -- wait (docs/architecture/outbox.md, "Pull").
                SELECT next_send_at, paused_until
                FROM telegram_bot_limits
                WHERE id = ${BOT_LIMITS_ID}
                  -- A pull with nothing to take leaves the row to the pulls that have something.
                  AND EXISTS (
                      SELECT 1
                      FROM telegram_outbox_chats
                      WHERE state = ${OutboxChatState.Ready}
                        AND next_attempt_at <= now()
                  )
                FOR UPDATE
            ),
            -- The time of the pull: the moment it holds the row, after any wait, which now(), the
            -- start of the statement, is not. The limits, the lease and the start of the attempt
            -- count from it: from now(), the pulls queued behind a slow one would all find a slot
            -- due and go out together. clock_timestamp() is read here, off the row the lock
            -- returned, not in bot, whose columns may be computed before the lock.
            pull_time AS (
                SELECT next_send_at, paused_until, clock_timestamp() AS pulled_at
                FROM bot
            ),
            budget AS (
                -- The slots of the common limit come due one per cooldown from next_send_at, and an
                -- idle bot saves up no more than number of them. The config bounds number only from
                -- below, so it is not cast to integer, which overflows above 2^31 - 1. The budget is at
                -- most limit, which fits a bigint.
                SELECT least(
                           ${limit}::bigint,
                           ${commonLimit.number}::double precision,
                           floor(extract(epoch FROM pulled_at - next_send_at) * ${MS_PER_SECOND} / ${commonCooldownMs}::double precision) + 1
                       )::bigint AS budget
                FROM pull_time
                WHERE next_send_at <= pulled_at
                  AND (paused_until IS NULL OR paused_until <= pulled_at)
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
                  -- By the time of the pull, as the budget: a chat that came due while the pull
                  -- waited for the bot row is taken. Without the row pulled_at is NULL, and so is
                  -- the budget.
                  AND chats.next_attempt_at <= (SELECT pulled_at FROM pull_time)
                ORDER BY head.priority, chats.next_attempt_at, chats.chat_id
                -- No budget: a pause, a spent limit or nothing to pull. NULL would lift the limit.
                LIMIT coalesce((SELECT budget FROM budget), 0)
                FOR UPDATE OF chats SKIP LOCKED
            ),
            pulled AS (
                -- The head comes from the snapshot of the statement (docs/architecture/outbox.md, "Pull").
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Processing},
                    updated_at = pull_time.pulled_at
                FROM heads, pull_time
                WHERE telegram_outbox.id = heads.id
                  AND telegram_outbox.status = ${OutboxStatus.Pending}
                RETURNING telegram_outbox.id, telegram_outbox.chat_id, method, payload, priority,
                          pull_time.pulled_at AS started_at,
                          jsonb_array_length(attempts) AS earlier_attempts
            ),
            moved AS (
                -- A negative chat id is a group, as isGroupChat() has it.
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Processing},
                    next_attempt_at = pull_time.pulled_at + CASE
                        WHEN telegram_outbox_chats.chat_id < 0 THEN ${this.cooldownMs(this.limits.group)}::double precision
                        ELSE ${this.cooldownMs(this.limits.private)}::double precision
                    END * interval '1 millisecond',
                    locked_until = pull_time.pulled_at + ${this.leaseDurationMs}::double precision * interval '1 millisecond',
                    lock_token = ${lockToken},
                    updated_at = pull_time.pulled_at
                FROM pulled, pull_time
                WHERE telegram_outbox_chats.chat_id = pulled.chat_id
            ),
            spent AS (
                -- From the pull, not from the slots saved up: a batch holds the next one back by a
                -- cooldown per message, so no interval gets more than number messages.
                UPDATE telegram_bot_limits
                SET next_send_at = pull_time.pulled_at + (SELECT count(*) FROM pulled) * ${commonCooldownMs}::double precision * interval '1 millisecond',
                    updated_at = pull_time.pulled_at
                FROM pull_time
                WHERE id = ${BOT_LIMITS_ID}
                  AND EXISTS (SELECT 1 FROM pulled)
                RETURNING telegram_bot_limits.next_send_at
            ),
            -- The row as this pull leaves it: as the lock found it, moved if something was pulled;
            -- the snapshot when the pull did not lock it, with now() for the time of the pull.
            bot_after AS (
                SELECT coalesce((SELECT next_send_at FROM spent), next_send_at) AS next_send_at, paused_until, pulled_at
                FROM pull_time
                UNION ALL
                SELECT next_send_at, paused_until, now()
                FROM telegram_bot_limits
                WHERE id = ${BOT_LIMITS_ID}
                  AND NOT EXISTS (SELECT 1 FROM pull_time)
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
                       SELECT ceil(greatest(extract(epoch FROM greatest(ready.ready_at, bot_after.next_send_at, bot_after.paused_until) - bot_after.pulled_at) * ${MS_PER_SECOND}, 0))::double precision
                       FROM ready
                       CROSS JOIN bot_after
                       WHERE ready.ready_at IS NOT NULL
                   ) AS next_pull_in_ms,
                   EXISTS (SELECT 1 FROM bot_after) AS has_bot_limits
        `;

        // A statement without FROM returns exactly one row.
        const pullRow = pullRows[0] as OutboxPullResultRow;

        // Without the row nothing is pulled and nextPullInMs is null, as if no chat were ready. A row
        // deleted while the pull waited for it is not seen: the pull answers from the snapshot, and
        // the next pull throws.
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
                lockToken: lockToken,
                startedAt: message.started_at,
                worker: worker,
                earlierAttempts: message.earlier_attempts,
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

    // The chats whose lease has passed, each with its processing message as a lease under the chat's
    // token. The lease stays: a completion under that token takes the message back, fenced as any
    // completion, so a late completion of the node presumed dead and a second recovery of the same
    // lease change nothing (docs/architecture/outbox.md, "Lease recovery").
    public async findExpiredLeases(): Promise<ExpiredOutboxLease[]> {
        const rows = await this.sql<ExpiredOutboxLeaseRow[]>`
            SELECT message.id,
                   chats.lock_token,
                   -- As jsonb writes a timestamp, the form of started_at the pull gives out: the
                   -- attempts of a message keep one form.
                   to_jsonb(chats.locked_until - ${this.leaseDurationMs}::double precision * interval '1 millisecond') #>> '{}' AS started_at,
                   jsonb_array_length(message.attempts) AS earlier_attempts
            FROM telegram_outbox_chats AS chats
            JOIN telegram_outbox AS message
                ON message.chat_id = chats.chat_id
               AND message.status = ${OutboxStatus.Processing}
            -- Only a pulled chat is leased: a completion clears the lease.
            WHERE chats.locked_until <= now()
            ORDER BY chats.locked_until, chats.chat_id
        `;

        return rows.map((row) => ({
            id: Number(row.id),
            lockToken: row.lock_token,
            startedAt: row.started_at,
            worker: null,
            earlierAttempts: row.earlier_attempts,
        }));
    }

    // The time a limit leaves between two messages. LIMIT_*_NUMBER is at least 1, so the cooldown is
    // finite.
    private cooldownMs(limit: TelegramLimits[keyof TelegramLimits]): number {
        return limit.interval / limit.number;
    }

    // The message is sent: the response goes to the row, and the chat goes on to its next message.
    // Returns whether the message is done by this completion: false for a fenced one, whose message
    // another completion has changed already.
    public async markAsDone(lease: OutboxLease, response: OutboxJson): Promise<boolean> {
        const chatId = await this.complete(lease, null, async (sql, lockedChatId) => {
            await this.finishMessage(sql, lease, { status: OutboxStatus.Done, attemptError: null, response: response });
            await this.releaseChat(sql, lockedChatId);
        });

        return chatId !== null;
    }

    // The message goes back to pending, and its chat waits delayMs or its chat limit, whichever is
    // later: the message stays the head, so it holds its chat. The chat is ready again, so the ready
    // channel is notified on commit as a push does: a node that sleeps on a null nextPullInMs, or
    // one whose node pulls no more, learns of the chat from nothing else. A fenced retry notifies no
    // one.
    public async retry(lease: OutboxLease, attemptError: OutboxAttemptError, delayMs: number): Promise<void> {
        await this.complete(lease, attemptError, async (sql, chatId) => {
            await this.updateProcessingMessage(
                lease,
                sql`
                    UPDATE telegram_outbox
                    SET status = ${OutboxStatus.Pending},
                        attempts = ${this.withAttempt(sql, lease, attemptError)},
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

            await this.notifyReady(sql);
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

        // A fenced completion changed nothing, so it logs no error: an alert on the error below
        // would fire for a chat this call did not block. Its failure is in the warning of
        // complete(), and a block by the completion that did apply logs the error below.
        if (chatId === null) {
            return;
        }

        this.logger.error("Outbox chat is blocked by a failed message.", {
            chatId: Number(chatId),
            messageId: lease.id,
            cause: attemptError,
        });
    }

    // Unblocks a chat by hand: the failed message that blocked it goes back to pending, and its id
    // makes it the head again. Returns that message. A chat that is not blocked throws
    // OutboxChatNotBlocked and changes nothing.
    public async retryBlockedChat(chatId: number): Promise<number> {
        return this.sql.begin(async (sql) => {
            const blocked = await this.lockBlockedChat(sql, chatId);

            await sql`
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Pending},
                    finished_at = NULL,
                    updated_at = now()
                WHERE id = ${blocked.messageId}
            `;

            // The head is pending, so the chat has an active message: ready is right.
            await this.setChatState(sql, blocked.chatId, OutboxChatState.Ready);
            // A node that sleeps on a null nextPullInMs learns of the chat from nothing else.
            await this.notifyReady(sql);

            return blocked.messageId;
        });
    }

    // Unblocks a chat by hand: the failed message that blocked it becomes skipped, and the chat goes
    // on with the message behind it, or goes idle when there is none. Returns the skipped message. A
    // chat that is not blocked throws OutboxChatNotBlocked and changes nothing.
    public async skipBlockedChat(chatId: number): Promise<number> {
        return this.sql.begin(async (sql) => {
            const blocked = await this.lockBlockedChat(sql, chatId);

            await sql`
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Skipped},
                    finished_at = now(),
                    updated_at = now()
                WHERE id = ${blocked.messageId}
            `;
            await this.notifyFinished(sql, blocked.messageId);

            // A ready chat with no head would be seen by no pull and spin the sender, so the state
            // follows the active messages left, read after the lock.
            await this.releaseChat(sql, blocked.chatId);

            return blocked.messageId;
        });
    }

    // One batch of the done and skipped messages whose retention has passed since their end; the
    // number deleted. A caller that gets a full batch calls again. A failed message is never deleted:
    // it waits for a person. A message without finished_at is never deleted either.
    public async deleteFinishedMessages(): Promise<number> {
        // finished_at plus the retention, not now() minus it: a long retention would take now()
        // below the earliest timestamp PostgreSQL has, 4713 BC, while the sum stays below its
        // latest for any retention the config takes.
        const deletedRows = await this.sql`
            DELETE FROM telegram_outbox
            WHERE id IN (
                SELECT id
                FROM telegram_outbox
                WHERE (status = ${OutboxStatus.Done}
                       AND finished_at + ${this.cleanupSettings.doneRetentionMs}::double precision * interval '1 millisecond' < now())
                   OR (status = ${OutboxStatus.Skipped}
                       AND finished_at + ${this.cleanupSettings.skippedRetentionMs}::double precision * interval '1 millisecond' < now())
                LIMIT ${this.cleanupSettings.batchSize}
                -- The lock rechecks the status on the newest version of the row, so a message moved
                -- back to pending meanwhile is kept; a row another cleanup holds is left to it.
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id
        `;

        return deletedRows.length;
    }

    // One batch of the idle chats whose chat limit has passed; the number deleted. A caller that gets
    // a full batch calls again. A push recreates the row of its chat, idle, with next_attempt_at of
    // now(): a chat whose limit has not passed keeps its row, so an idle spell does not shorten the
    // limit. A chat another transaction holds is skipped: a push or a completion is changing it. The
    // lock rechecks the state on the newest version of the row, so a chat that a push or a completion
    // has changed meanwhile is left alone too.
    public async deleteIdleChats(): Promise<number> {
        const deletedRows = await this.sql`
            DELETE FROM telegram_outbox_chats
            WHERE chat_id IN (
                SELECT chat_id
                FROM telegram_outbox_chats
                WHERE state = ${OutboxChatState.Idle}
                  AND next_attempt_at <= now()
                LIMIT ${this.cleanupSettings.batchSize}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING chat_id
        `;

        return deletedRows.length;
    }

    // What waits in the outbox, for the status line of the maintenance. With no index on status yet
    // the count reads the whole of telegram_outbox, done messages included (#643).
    public async readBacklog(): Promise<OutboxBacklog> {
        const [row] = await this.sql<OutboxBacklogRow[]>`
            SELECT messages.pending_count,
                   messages.processing_count,
                   chats.blocked_chat_count,
                   -- By the database clock, the one the pause is set by. greatest() skips a NULL
                   -- paused_until, so no pause is 0.
                   ceil(greatest(extract(epoch FROM bot.paused_until - now()) * ${MS_PER_SECOND}, 0))::double precision AS pause_left_ms
            FROM telegram_bot_limits AS bot
            CROSS JOIN (
                SELECT count(*) FILTER (WHERE status = ${OutboxStatus.Pending}) AS pending_count,
                       count(*) FILTER (WHERE status = ${OutboxStatus.Processing}) AS processing_count
                FROM telegram_outbox
                WHERE status IN ${this.sql(ACTIVE_STATUSES)}
            ) AS messages
            CROSS JOIN (
                SELECT count(*) AS blocked_chat_count
                FROM telegram_outbox_chats
                WHERE state = ${OutboxChatState.Blocked}
            ) AS chats
            WHERE bot.id = ${BOT_LIMITS_ID}
        `;

        if (row === undefined) {
            throw BotLimitsRowMissing.create();
        }

        return {
            pendingCount: Number(row.pending_count),
            processingCount: Number(row.processing_count),
            blockedChatCount: Number(row.blocked_chat_count),
            pauseLeftMs: row.pause_left_ms,
        };
    }

    // Every completion: the lock of the chat, then the fence, then the writes (docs/architecture/outbox.md,
    // "The chat lock"). A missing message throws OutboxMessageNotLeased. A lock token that is not
    // the chat's changes nothing and is logged with the error the completion carried: the lease has
    // passed to another pull, or the chat was released by an earlier completion. A chat row that is
    // missing while its message is there changes nothing either and is logged apart:
    // deleteIdleChats() removed the chat once it went idle, so no lease is left. Returns the chat of
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
                if (!(await this.hasMessage(sql, lease.id))) {
                    throw OutboxMessageNotLeased.byId(lease.id);
                }

                this.logger.warning("Outbox completion of a chat the cleanup removed changed nothing.", {
                    messageId: lease.id,
                    lockToken: lease.lockToken,
                    cause: attemptError,
                });

                return null;
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

    // The lock of a chat to unblock, then its failed message that blocked it: the one that failed
    // last, since a blocked chat is pulled no more. The state is read from the locked row, so a chat
    // that a completion or another unblock changed while this call waited is seen as it is now.
    private async lockBlockedChat(sql: TransactionSql, chatId: number): Promise<{ chatId: string; messageId: number }> {
        const [chat] = await sql<{ chat_id: string; state: string }[]>`
            SELECT chat_id, state
            FROM telegram_outbox_chats
            WHERE chat_id = ${chatId}
            FOR UPDATE
        `;

        if (chat === undefined || chat.state !== OutboxChatState.Blocked) {
            throw OutboxChatNotBlocked.byChatId(chatId);
        }

        const [failedMessage] = await sql<{ id: string }[]>`
            SELECT id
            FROM telegram_outbox
            WHERE chat_id = ${chat.chat_id}
              AND status = ${OutboxStatus.Failed}
            ORDER BY finished_at DESC, id DESC
            LIMIT 1
        `;

        // Only markAsFailedAndBlockChat() blocks a chat, in the transaction that fails the message,
        // and a failed message is never deleted: a chat blocked without one was edited by hand.
        if (failedMessage === undefined) {
            throw OutboxChatNotBlocked.byChatId(chatId);
        }

        return { chatId: chat.chat_id, messageId: Number(failedMessage.id) };
    }

    private async hasMessage(sql: TransactionSql, messageId: number): Promise<boolean> {
        const [message] = await sql`SELECT id FROM telegram_outbox WHERE id = ${messageId}`;

        return message !== undefined;
    }

    // The final outcome of a message, with the end of its attempt. finished_at is for the cleanup.
    private async finishMessage(sql: TransactionSql, lease: OutboxLease, outcome: OutboxFinalOutcome): Promise<void> {
        const { status, attemptError, response } = outcome;

        await this.updateProcessingMessage(
            lease,
            sql`
                UPDATE telegram_outbox
                SET status = ${status},
                    attempts = ${this.withAttempt(sql, lease, attemptError)},
                    response = ${response === null ? null : sql.json(response)},
                    finished_at = now(),
                    updated_at = now()
                WHERE id = ${lease.id}
                  AND status = ${OutboxStatus.Processing}
                RETURNING id
            `,
        );

        await this.notifyFinished(sql, lease.id);
    }

    // Every transaction that moves a message into done, failed or skipped calls it: a caller waiting on
    // another node learns of the outcome only from the poll otherwise (docs/architecture/invariants.md).
    // The notification goes through sql of that transaction, so PostgreSQL delivers it on commit and
    // the waiter that reads the row on it sees the outcome. Not sql.notify() of postgres.js: it runs
    // on the pool whatever sql it is called on (notify() in its src/index.js), so inside a transaction
    // it would notify before the commit, and even for a transaction that rolls back.
    private async notifyFinished(sql: TransactionSql, messageId: number): Promise<void> {
        await sql`SELECT pg_notify(${OutboxChannel.Finished}, ${String(messageId)})`;
    }

    // Wakes the senders that sleep with nothing to pull. Through sql of the transaction that made a
    // chat ready, as notifyFinished(), so it is delivered on commit and a sender that wakes up on it
    // sees the chat. No ids in it: the sender takes what it pulls, not what was pushed, and a batch of
    // ids could outgrow the 8000 bytes of a NOTIFY payload.
    private async notifyReady(sql: TransactionSql): Promise<void> {
        await sql`SELECT pg_notify(${OutboxChannel.Ready}, '')`;
    }

    // The token is the chat's, so the chat is processing with one message: another message of the
    // chat is a wrong id.
    private async updateProcessingMessage(lease: OutboxLease, update: PendingQuery<Row[]>): Promise<void> {
        const [updated] = await update;

        if (updated === undefined) {
            throw OutboxMessageNotLeased.byId(lease.id);
        }
    }

    // The attempts with this one appended: its start and worker from the lease, its error, null for a
    // success, and its end by the database clock, as its start.
    private withAttempt(sql: TransactionSql, lease: OutboxLease, attemptError: OutboxAttemptError | null): PendingQuery<Row[]> {
        const { worker } = lease;
        const attempt: Omit<OutboxAttempt, "finished_at"> = {
            started_at: lease.startedAt,
            worker: worker === null ? null : { host: worker.host, pid: worker.pid, worker_id: worker.workerId },
            error: attemptError,
        };

        return sql`attempts || jsonb_build_array(${sql.json(attempt)}::jsonb || jsonb_build_object('finished_at', now()))`;
    }

    // The chat goes on: ready while it has a message left, idle otherwise. The active messages are
    // read after the lock, so a message pushed meanwhile is seen. A ready chat notifies the ready
    // channel: a source that slept on a pull that found this chat processing would otherwise sleep
    // out its cap with the next message due.
    private async releaseChat(sql: TransactionSql, chatId: string): Promise<void> {
        const [remainingMessage] = await sql`
            SELECT id
            FROM telegram_outbox
            WHERE chat_id = ${chatId}
              AND status IN ${sql(ACTIVE_STATUSES)}
            LIMIT 1
        `;

        if (remainingMessage === undefined) {
            await this.setChatState(sql, chatId, OutboxChatState.Idle);

            return;
        }

        await this.setChatState(sql, chatId, OutboxChatState.Ready);
        await this.notifyReady(sql);
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
