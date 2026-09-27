import { inject, injectable } from "inversify";
import type { Database, Sql } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import type { ClaimedOutboxMessage, ClaimedOutboxRow, OutboxJson, OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";

// The rows and the chat states of the outbox: the model is in docs/architecture/outbox.md. The
// chat row is the lock of its chat: whoever changes the state of a chat locks its row first.
@injectable()
export class OutboxStore {
    private readonly sql: Sql;

    public constructor(@inject<Database>(Tokens.Platform.Database) database: Database) {
        this.sql = database.sql;
    }

    public async enqueue(message: OutboxMessageInput): Promise<number> {
        const [id] = await this.enqueueBatch([message]);

        // One message in, one id out: the batch inserts every message it gets.
        return id as number;
    }

    // One statement: the rows and their chats commit together. The ids come back in the order of
    // the input, which is the order of the messages inside a chat.
    public async enqueueBatch(messages: OutboxMessageInput[]): Promise<number[]> {
        const rows = await this.sql<{ id: string }[]>`
            with inserted as (
                insert into telegram_outbox (chat_id, method, payload, priority)
                select (message ->> 'chatId')::bigint,
                       message ->> 'method',
                       message -> 'payload',
                       (message ->> 'priority')::smallint
                from jsonb_array_elements(${this.sql.json(messages)}) with ordinality as input(message, position)
                order by position
                returning id, chat_id, priority
            ),
            heads as (
                select distinct on (chat_id) chat_id, priority
                from inserted
                order by chat_id, id
            ),
            chats as (
                -- Only an idle chat gets a new head. The conflicting row is locked even when the
                -- condition fails, so an enqueue waits for a completion of the same chat.
                insert into telegram_outbox_chats (chat_id, state, head_priority)
                select chat_id, 'ready', priority
                from heads
                on conflict (chat_id) do update
                set state = 'ready',
                    head_priority = excluded.head_priority
                where telegram_outbox_chats.state = 'idle'
            )
            select id
            from inserted
            order by id
        `;

        return rows.map((row) => Number(row.id));
    }

    // One statement: up to limit ready chats and the head of each. A chat locked by another claimer
    // is skipped, not waited for. The claimed chat moves to the back of the order, so the chats are
    // served in turn.
    public async claim(limit: number): Promise<ClaimedOutboxMessage[]> {
        const rows = await this.sql<ClaimedOutboxRow[]>`
            with chats as (
                select chat_id
                from telegram_outbox_chats
                where state = 'ready'
                order by next_send_at
                limit ${limit}
                for update skip locked
            ),
            heads as (
                select head.id
                from chats
                cross join lateral (
                    select id
                    from telegram_outbox
                    where chat_id = chats.chat_id
                      and status in ('pending', 'processing', 'failed')
                    order by id
                    limit 1
                ) as head
            ),
            claimed as (
                -- The head was read from the snapshot of the statement: a head completed since
                -- then no longer passes the status check and is not taken twice.
                update telegram_outbox
                set status = 'processing'
                from heads
                where telegram_outbox.id = heads.id
                  and telegram_outbox.status = 'pending'
                returning telegram_outbox.id, chat_id, method, payload, priority
            ),
            moved as (
                update telegram_outbox_chats
                set state = 'processing',
                    next_send_at = now()
                from claimed
                where telegram_outbox_chats.chat_id = claimed.chat_id
            )
            select *
            from claimed
            order by id
        `;

        return rows.map((row) => ({
            id: Number(row.id),
            chatId: Number(row.chat_id),
            method: row.method,
            payload: row.payload,
            priority: row.priority,
        }));
    }

    // false — the message is not processing, and nothing changed. Separate statements rather than
    // one: each reads a fresh snapshot after the chat lock, so the next head includes a message
    // enqueued while the lock was awaited.
    public async markDone(id: number, response: OutboxJson): Promise<boolean> {
        return this.sql.begin(async (sql) => {
            await sql`
                select chat_id
                from telegram_outbox_chats
                where chat_id = (select chat_id from telegram_outbox where id = ${id})
                for update
            `;

            const [done] = await sql<{ chat_id: string }[]>`
                update telegram_outbox
                set status = 'done',
                    response = ${sql.json(response)},
                    finished_at = now()
                where id = ${id}
                  and status = 'processing'
                returning chat_id
            `;

            if (done === undefined) {
                return false;
            }

            await sql`
                update telegram_outbox_chats
                set state = case when head.priority is null then 'idle' else 'ready' end,
                    head_priority = head.priority
                from (
                    select (
                        select priority
                        from telegram_outbox
                        where chat_id = ${done.chat_id}
                          and status in ('pending', 'processing', 'failed')
                        order by id
                        limit 1
                    ) as priority
                ) as head
                where chat_id = ${done.chat_id}
            `;

            return true;
        });
    }
}
