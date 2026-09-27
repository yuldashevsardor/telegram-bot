import { inject, injectable } from "inversify";
import type { Database, Sql } from "app/platform/database/database";
import { Tokens } from "app/shared/tokens";
import type { ClaimedOutboxMessage, ClaimedOutboxRow, OutboxJson, OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";

// The rows and the chat states of the outbox: the model is in docs/architecture/outbox.md.
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

    // The rows and their chats commit together. The ids come back in the order of the input, which
    // is the order of the messages inside a chat. They are taken only once the chats are locked
    // (docs/architecture/outbox.md, "The chat lock").
    public async enqueueBatch(messages: OutboxMessageInput[]): Promise<number[]> {
        return this.sql.begin(async (sql) => {
            // A new chat is created idle; an existing one is only locked: the update never passes
            // its where, and the conflicting row is locked all the same. In chat_id order, so two
            // batches lock the chats they share in the same order.
            await sql`
                insert into telegram_outbox_chats (chat_id, state)
                select distinct (message ->> 'chatId')::bigint, 'idle'
                from jsonb_array_elements(${sql.json(messages)}) as input(message)
                order by 1
                on conflict (chat_id) do update
                set state = excluded.state
                where false
            `;

            const rows = await sql<{ id: string }[]>`
                with inserted as (
                    insert into telegram_outbox (chat_id, method, payload, priority)
                    select (message ->> 'chatId')::bigint,
                           message ->> 'method',
                           message -> 'payload',
                           (message ->> 'priority')::smallint
                    from jsonb_array_elements(${sql.json(messages)}) with ordinality as input(message, position)
                    order by position
                    returning id, chat_id, priority
                ),
                heads as (
                    select distinct on (chat_id) chat_id, priority
                    from inserted
                    order by chat_id, id
                ),
                chats as (
                    -- Only an idle chat gets a new head: any other one already has an older head.
                    update telegram_outbox_chats
                    set state = 'ready',
                        head_priority = heads.priority
                    from heads
                    where telegram_outbox_chats.chat_id = heads.chat_id
                      and telegram_outbox_chats.state = 'idle'
                )
                select id
                from inserted
                order by id
            `;

            return rows.map((row) => Number(row.id));
        });
    }

    // One statement: up to limit ready chats and the head of each. A chat locked by another claimer
    // is skipped, not waited for. A claimed chat moves behind the chats of its priority, so they
    // are served in turn.
    public async claim(limit: number): Promise<ClaimedOutboxMessage[]> {
        const rows = await this.sql<ClaimedOutboxRow[]>`
            with chats as (
                select chat_id
                from telegram_outbox_chats
                where state = 'ready'
                order by head_priority, next_send_at
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
                -- The head comes from the snapshot of the statement (docs/architecture/outbox.md, "Claim").
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

    // false — the message is not processing, and nothing changed. The statements are separate on
    // purpose (docs/architecture/outbox.md, "The chat lock").
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
