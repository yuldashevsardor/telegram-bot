import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";
import type { PendingQuery, Row, TransactionSql } from "postgres";
import type { Database, Sql } from "app/platform/database/database";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { Limit, TelegramLimits } from "app/bootstrap/config/config-values";
import { configValue } from "app/shared/config-value";
import { MS_PER_SECOND } from "app/shared/time";
import type {
    BlockedOutboxChatCountRow,
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
    InvalidRetryDelay,
    InvalidPullLimit,
    OutboxChatNotBlocked,
    OutboxMessageNotLeased,
} from "app/telegram/outbox/store/outbox-store.errors";

// The OID of bigint: the chat ids go to the database as a bigint[] parameter.
const BIGINT = 20;

// The statuses a chat head can be in: its first message by priority, then by id, among them. A
// failed message is not among them: the chat it blocks is held by its state, and one that does not
// block lets the next message through.
const ACTIVE_STATUSES = [OutboxStatus.Pending, OutboxStatus.Processing];

// The single row of telegram_bot_limits.
const BOT_LIMITS_ID = 1;

// The ceiling of a pause or a retry delay, some 285 000 years: it stays below the overflow of the
// interval PostgreSQL adds to now(), at 2^63 µs, while 1e17 ms overflows it.
const MAX_DELAY_MS = Number.MAX_SAFE_INTEGER;

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
    // is the order of the messages of one priority inside a chat. They are taken only once the chats
    // are locked (docs/architecture/outbox.md, "The chat lock").
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

            // An idle chat gets its first message and becomes ready. In a ready chat a message more
            // urgent than its head becomes the head, so the copy is read again
            // (docs/architecture/outbox.md, "Tables"), and written only where it changes: every update
            // of a ready chat leaves a dead entry in the pull index. A processing chat reads its head
            // with its completion, and a blocked one stays blocked until its unblock. The head of a
            // ready chat is looked up twice, for the WHERE and for the SET, each walking the dead
            // entries of the head index before the head until a vacuum: a join for one lookup would
            // read the head by a query of its own, beside headPrioritySubquery().
            await sql`
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Ready},
                    head_priority = ${this.headPrioritySubquery(sql)},
                    updated_at = now()
                WHERE chat_id = ANY(${sql.array(chatIds, BIGINT)}::bigint[])
                  AND (
                      state = ${OutboxChatState.Idle}
                      OR (state = ${OutboxChatState.Ready} AND head_priority IS DISTINCT FROM ${this.headPrioritySubquery(sql)})
                  )
            `;

            await this.notifyReady(sql);

            return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
        });
    }

    // onReady is called on the commit of every write on any node that leaves a chat ready (a push, a
    // completion, an unblock), and every time the listening starts: the first time and after a
    // reconnect, since a write committed while the connection was down is heard by no one. Resolves
    // once the listening starts (docs/architecture/storage.md, "LISTEN").
    public async listenReady(onReady: () => void): Promise<void> {
        await this.sql.listen(OutboxChannel.Ready, () => onReady(), onReady);
    }

    // One statement, so it is atomic without a transaction: up to limit ready chats by the priority
    // of their head, and the head of each, within the common limit, the chat limit and the pause
    // (docs/architecture/outbox.md, "Pull").
    public async pull(limit: number, worker: OutboxWorker): Promise<OutboxPullResult> {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw InvalidPullLimit.of(limit);
        }

        // One token per pull is enough: a chat is leased to one pull at a time, and the token only
        // has to tell that pull from the next one of the same chat.
        const lockToken = randomUUID();
        const commonLimit = this.limits.common;
        const commonCooldownMs = this.cooldownMs(commonLimit);
        const hasWindowPassed = this.hasPrivateWindowPassed(this.sql`heads.window_started_at`, this.sql`pull_time.pulled_at`);

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
                -- idle bot saves up no more than number of them. The config bounds number from above
                -- only by Number.MAX_SAFE_INTEGER, far past 2^31 - 1, so it is not cast to integer,
                -- which would overflow. The budget is at most limit, which fits a bigint.
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
                -- The outer LIMIT, which takes nothing off, is for the planner (docs/architecture/outbox.md, "Pull").
                SELECT chat_id, id, status, window_started_at, window_sent_count
                FROM (
                    -- The window as the lock found it, not as the snapshot has it: a chat pulled and
                    -- retried after the snapshot passes the lock with its head (docs/architecture/outbox.md, "Pull").
                    SELECT chats.chat_id, head.id, head.status, chats.window_started_at, chats.window_sent_count
                    FROM telegram_outbox_chats AS chats
                    CROSS JOIN LATERAL (
                        SELECT id, status
                        FROM telegram_outbox
                        WHERE chat_id = chats.chat_id
                          AND status IN ${this.sql(ACTIVE_STATUSES)}
                        ORDER BY priority, id
                        LIMIT 1
                    ) AS head
                    WHERE chats.state = ${OutboxChatState.Ready}
                      -- Keeps a processing head from going out twice (docs/architecture/outbox.md, "Pull").
                      AND head.status = ${OutboxStatus.Pending}
                      -- By the time of the pull, as the budget: a chat that came due while the pull
                      -- waited for the bot row is taken. Without the row pulled_at is NULL, and so is
                      -- the budget.
                      AND chats.next_attempt_at <= (SELECT pulled_at FROM pull_time)
                    -- The copy of the head's priority, not head.priority: in the order of the pull index,
                    -- the pull looks up the heads of its batch alone, not of every ready chat.
                    ORDER BY chats.head_priority, chats.next_attempt_at, chats.chat_id
                    -- No budget: a pause, a spent limit or nothing to pull. NULL would lift the limit.
                    LIMIT coalesce((SELECT budget FROM budget), 0)
                    FOR UPDATE OF chats SKIP LOCKED
                ) AS budget_heads
                LIMIT ${limit}
            ),
            pulled AS (
                -- The head comes from the snapshot of the statement, and its status is matched against
                -- the snapshot's, not against pending (docs/architecture/outbox.md, "Pull").
                UPDATE telegram_outbox
                SET status = ${OutboxStatus.Processing},
                    updated_at = pull_time.pulled_at
                FROM heads, pull_time
                WHERE telegram_outbox.id = heads.id
                  AND telegram_outbox.status = heads.status
                RETURNING telegram_outbox.id, telegram_outbox.chat_id, method, payload, priority,
                          pull_time.pulled_at AS started_at,
                          jsonb_array_length(attempts) AS earlier_attempts
            ),
            -- The window of each private chat pulled, a negative chat id being a group, as isGroupChat()
            -- has it. A CTE of its own: next_attempt_at depends on the new count, and every SET of one
            -- UPDATE sees the old row.
            windows AS (
                SELECT heads.chat_id,
                       CASE
                           WHEN ${hasWindowPassed} THEN pull_time.pulled_at
                           ELSE heads.window_started_at
                       END AS window_started_at,
                       CASE
                           WHEN ${hasWindowPassed} THEN 1
                           ELSE heads.window_sent_count + 1
                       END AS window_sent_count
                FROM heads
                JOIN pulled ON pulled.chat_id = heads.chat_id
                CROSS JOIN pull_time
                WHERE heads.chat_id >= 0
            ),
            moved AS (
                -- A group waits its cooldown. A private chat is pulled again at once until its window
                -- holds number messages, then at the end of the window. The config bounds number from
                -- above only by Number.MAX_SAFE_INTEGER, far past 2^31 - 1, so it is not cast to
                -- integer; the count it is compared with is an integer all the same, since no window
                -- gets 2^31 pulls.
                UPDATE telegram_outbox_chats
                SET state = ${OutboxChatState.Processing},
                    window_started_at = windows.window_started_at,
                    window_sent_count = windows.window_sent_count,
                    next_attempt_at = CASE
                        WHEN telegram_outbox_chats.chat_id < 0
                            THEN pull_time.pulled_at + ${this.cooldownMs(this.limits.group)}::double precision * interval '1 millisecond'
                        WHEN windows.window_sent_count >= ${this.limits.private.number}::double precision
                            THEN ${this.privateWindowEnd(this.sql`windows.window_started_at`)}
                        ELSE pull_time.pulled_at
                    END,
                    locked_until = pull_time.pulled_at + ${this.leaseDurationMs}::double precision * interval '1 millisecond',
                    lock_token = ${lockToken},
                    updated_at = pull_time.pulled_at
                FROM pulled
                CROSS JOIN pull_time
                LEFT JOIN windows ON windows.chat_id = pulled.chat_id
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

    // Stops the pull on every node until now() + durationMs by the database clock, never shortening
    // a pause (docs/architecture/outbox.md, "Limits", the pause).
    public async pause(durationMs: number): Promise<void> {
        if (!this.isDelayInRange(durationMs)) {
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
            SELECT leased.id,
                   chats.lock_token,
                   -- As jsonb writes a timestamp, the form of started_at the pull gives out: the
                   -- attempts of a message keep one form.
                   to_jsonb(chats.locked_until - ${this.leaseDurationMs}::double precision * interval '1 millisecond')
                       #>> '{}' AS started_at,
                   jsonb_array_length(leased.attempts) AS earlier_attempts
            FROM telegram_outbox_chats AS chats
            -- The processing message was the head when it was pulled, but a more urgent message pushed
            -- since sorts before it, so the lookup walks the head index of the chat to the first
            -- processing entry: only the more urgent messages pushed during the lease lie before it.
            -- Without the LIMIT to stop at it, the lookup read every active message of the chat
            -- (docs/architecture/outbox-load-test.md, "The lease recovery").
            CROSS JOIN LATERAL (
                SELECT id, attempts
                FROM telegram_outbox
                WHERE chat_id = chats.chat_id
                  AND status = ${OutboxStatus.Processing}
                ORDER BY priority, id
                LIMIT 1
            ) AS leased
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

    // The end of the window of a private chat that opened at windowStartedAt, a column.
    private privateWindowEnd(windowStartedAt: PendingQuery<Row[]>): PendingQuery<Row[]> {
        return this.sql`${windowStartedAt} + ${this.limits.private.interval}::double precision * interval '1 millisecond'`;
    }

    // Whether a private chat whose window opened at windowStartedAt has none open at time: none was
    // opened, or it has ended. The pull and the cleanup share it: a cleanup that saw a window passed
    // before the pull does would remove a count the pull still holds.
    private hasPrivateWindowPassed(windowStartedAt: PendingQuery<Row[]>, time: PendingQuery<Row[]>): PendingQuery<Row[]> {
        return this.sql`(${windowStartedAt} IS NULL OR ${this.privateWindowEnd(windowStartedAt)} <= ${time})`;
    }

    // NaN fails both comparisons, and an infinity the second one.
    private isDelayInRange(delayMs: number): boolean {
        return delayMs >= 0 && delayMs <= MAX_DELAY_MS;
    }

    // The time the common or the group limit leaves between two messages. LIMIT_*_NUMBER is at least
    // 1, so the cooldown is finite.
    private cooldownMs(limit: Limit): number {
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
    // later: the message is the head again unless a more urgent one was pushed meanwhile, and the
    // head holds its chat. The chat is ready again, so the ready channel is notified on commit as a
    // push does: a node that sleeps on a null nextPullInMs, and every other node when the node of the
    // message stops, learn of the chat from nothing else. A fenced retry notifies no one.
    public async retry(lease: OutboxLease, attemptError: OutboxAttemptError, delayMs: number): Promise<void> {
        // The contract of the store for any caller, as in pause(): an infinite delay would hold the
        // chat for ever, and MAX_DELAY_MS keeps the interval below its overflow.
        if (!this.isDelayInRange(delayMs)) {
            throw InvalidRetryDelay.of(delayMs);
        }

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
    // puts it before the messages of its priority. Returns that message. A chat that is not blocked
    // throws OutboxChatNotBlocked and changes nothing.
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
        // now() minus the retention, a bound of finished_at alone: the index on finished_at serves
        // it. A retention that reaches past 4713 BC, the earliest timestamp, fails it out of range.
        const deletedRows = await this.sql`
            DELETE FROM telegram_outbox
            WHERE id IN (
                SELECT id
                FROM telegram_outbox
                WHERE (status = ${OutboxStatus.Done}
                       AND finished_at < now() - ${this.cleanupSettings.doneRetentionMs}::double precision * interval '1 millisecond')
                   OR (status = ${OutboxStatus.Skipped}
                       AND finished_at < now() - ${this.cleanupSettings.skippedRetentionMs}::double precision * interval '1 millisecond')
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
    // now() and no window: a chat whose limit has not passed keeps its row, so an idle spell does not
    // shorten the limit. The limit of a private chat is its window as well: its next_attempt_at passes
    // right after a pull that leaves the window short of full. A chat another transaction holds is
    // skipped: a push or a completion is changing it. The lock rechecks the state on the newest
    // version of the row, so a chat that a push or a completion has changed meanwhile is left alone
    // too.
    public async deleteIdleChats(): Promise<number> {
        const deletedRows = await this.sql`
            DELETE FROM telegram_outbox_chats
            WHERE chat_id IN (
                SELECT chat_id
                FROM telegram_outbox_chats
                WHERE state = ${OutboxChatState.Idle}
                  AND next_attempt_at <= now()
                  AND ${this.hasPrivateWindowPassed(this.sql`window_started_at`, this.sql`now()`)}
                LIMIT ${this.cleanupSettings.batchSize}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING chat_id
        `;

        return deletedRows.length;
    }

    // What waits in the outbox, for the status line of the maintenance. The count reads the head
    // index alone, whose entries hold the status, and the row of a message only on a page the
    // visibility map does not mark all-visible yet (docs/architecture/outbox-load-test.md, "The
    // status line").
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

    // The chats waiting to be unblocked by hand, for the error line of the maintenance. No index for
    // blocked: the table holds only the chats with work, and a full read of 100 000 of them takes
    // about 10 ms (docs/architecture/outbox-load-test.md), once per interval of the maintenance.
    public async countBlockedChats(): Promise<number> {
        // An aggregate without GROUP BY gives one row, an empty table included, so the row is
        // asserted, not checked.
        const [row] = await this.sql<BlockedOutboxChatCountRow[]>`
            SELECT count(*) AS blocked_chat_count
            FROM telegram_outbox_chats
            WHERE state = ${OutboxChatState.Blocked}
        `;

        return Number(row!.blocked_chat_count);
    }

    // Every completion: the lock of the chat, then the fence, then the writes (docs/architecture/outbox.md,
    // "The chat lock", "Completions"). Returns the chat of an applied completion, null for a fenced
    // one.
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
    // Through sql of that transaction, so it is delivered on commit, not through sql.notify(), which
    // runs on the pool (docs/architecture/outbox.md, "Waiting for the result").
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

    // The lease ends with the completion: a late completion of the same pull finds no token. The
    // head may have moved with the message the caller changed, so its priority is read again.
    private async setChatState(sql: TransactionSql, chatId: string, state: OutboxChatState): Promise<void> {
        await sql`
            UPDATE telegram_outbox_chats
            SET state = ${state},
                head_priority = ${this.headPrioritySubquery(sql)},
                locked_until = NULL,
                lock_token = NULL,
                updated_at = now()
            WHERE chat_id = ${chatId}
        `;
    }

    // The copy of the head's priority on the chat row, for the SET or the WHERE of an UPDATE of
    // telegram_outbox_chats without an alias: the subquery names the chat by that table. The pull
    // orders the ready chats by it from an index instead of looking up the head of each
    // (docs/architecture/outbox.md, "Tables"). NULL for a chat with no active message.
    private headPrioritySubquery(sql: TransactionSql): PendingQuery<Row[]> {
        return sql`(
            SELECT priority
            FROM telegram_outbox
            WHERE chat_id = telegram_outbox_chats.chat_id
              AND status IN ${sql(ACTIVE_STATUSES)}
            ORDER BY priority, id
            LIMIT 1
        )`;
    }
}
