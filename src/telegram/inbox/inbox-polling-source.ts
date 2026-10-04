import { setTimeout as pauseFor } from "node:timers/promises";
import { Api, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { inject, injectable } from "inversify";
import postgres from "postgres";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import { ALLOWED_UPDATES } from "app/telegram/bot/bot";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxGroupKey, InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import type { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";

// How long getUpdates waits for an update before it answers with none.
const POLL_TIMEOUT_SECONDS = 30;
// The HTTP call of a poll: the long poll and a margin for the answer. grammY waits 500 s by default,
// and a call stuck on a dead connection would hold the polling that long.
const API_TIMEOUT_SECONDS = POLL_TIMEOUT_SECONDS + 10;
// The most updates the Bot API gives in one getUpdates: a backlog drains in as few inserts as it can.
const POLL_LIMIT = 100;
// The pause after a failed call or insert before the source tries again.
const RETRY_PAUSE_MS = 3_000;
// The SQLSTATE class of a data exception: PostgreSQL refused a value of the update itself, such as a
// \u0000 escape or a lone surrogate in jsonb, and the same update fails every time it is pushed.
const DATA_EXCEPTION_CLASS = "22";

// The signal as grammY types it: by the abort-controller shim of its Node build. At run time it takes
// the native one.
type ApiSignal = NonNullable<Parameters<Api["getMe"]>[0]>;

// Takes the updates from Telegram by long polling into the inbox (docs/architecture/inbox.md, "The
// polling source"). One process polls: Telegram answers a second getUpdates of the same bot with 409.
@injectable()
export class InboxPollingSource {
    // Aborts the Bot API call in flight and cuts the pause short.
    private readonly stopController = new AbortController();
    private readonly apiSignal = this.stopController.signal as unknown as ApiSignal;
    private runCompletion: Promise<void> = Promise.resolve();

    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer) private readonly errorSerializer: OutboxErrorSerializer,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        // Its own, without the transformers of the bot: getUpdates has nothing to do with the outbox.
        private readonly api: Api = new Api(configValue("bot.token"), { timeoutSeconds: API_TIMEOUT_SECONDS }),
        private readonly retryPauseMs: number = RETRY_PAUSE_MS,
    ) {}

    // Called once: a second loop would poll the same bot and get 409 from Telegram.
    public start(): void {
        this.runCompletion = this.run();
    }

    // No getUpdates after it: the call in flight is aborted, and an insert in flight is awaited, so
    // the updates it got are stored. Telegram learns the offset of the last batch only from the next
    // getUpdates, so the next start gets that batch again, and the push leaves out what it stored.
    public async stop(): Promise<void> {
        this.stopController.abort();

        await this.runCompletion;
    }

    private async run(): Promise<void> {
        const me = await this.prepare();

        if (me === undefined) {
            return;
        }

        // Lower than any update_id: Telegram answers it from the first update it has not been told of.
        let offset = 0;

        while (!this.isStopped()) {
            const updates = await this.getUpdates(offset);

            if (updates === undefined) {
                await this.pause();

                continue;
            }

            const isStored = await this.storeUpdates(updates, me);

            if (!isStored) {
                await this.pause();

                continue;
            }

            const lastUpdate = updates.at(-1);

            // The offset moves only once the updates are stored: the next getUpdates tells Telegram
            // that the bot has them, and Telegram forgets them.
            if (lastUpdate !== undefined) {
                offset = lastUpdate.update_id + 1;
            }
        }
    }

    // Telegram gives no getUpdates while a webhook is set. getMe gives the bot for the Context that
    // reads the group of an update. undefined: stopped before both went through.
    private async prepare(): Promise<UserFromGetMe | undefined> {
        while (!this.isStopped()) {
            try {
                await this.api.deleteWebhook({}, this.apiSignal);

                return await this.api.getMe(this.apiSignal);
            } catch (error) {
                this.logCallFailure("Preparing the polling failed, the source tries again.", error, {});
                await this.pause();
            }
        }

        return undefined;
    }

    // undefined: the call failed or was aborted by the stop.
    private async getUpdates(offset: number): Promise<Update[] | undefined> {
        try {
            return await this.api.getUpdates(
                { offset: offset, limit: POLL_LIMIT, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ALLOWED_UPDATES },
                this.apiSignal,
            );
        } catch (error) {
            this.logCallFailure("Getting updates failed, the source tries again from the same offset.", error, { offset: offset });

            return undefined;
        }
    }

    // false: not every update is stored or dropped, and the batch is to be got again from the same
    // offset; the updates stored already are left out by the push.
    private async storeUpdates(updates: Update[], me: UserFromGetMe): Promise<boolean> {
        const inputs = this.toInputs(updates, me);

        try {
            await this.store.pushBatch(inputs);

            return true;
        } catch (error) {
            if (!this.isRefusedUpdate(error)) {
                this.logStoreFailure(inputs, error);

                return false;
            }

            return await this.pushOneByOne(inputs);
        }
    }

    // pushBatch() stores the batch in one statement, so one refused update rolls back the others, and
    // every retry from the same offset fails on it again. One at a time, the others go in, and the
    // refused one is dropped.
    private async pushOneByOne(inputs: InboxUpdateInput[]): Promise<boolean> {
        for (const input of inputs) {
            try {
                await this.store.push(input);
            } catch (error) {
                if (!this.isRefusedUpdate(error)) {
                    this.logStoreFailure(inputs, error);

                    return false;
                }

                this.logger.error("The inbox refused an update, it is dropped.", { updateId: input.update.update_id, cause: error });
            }
        }

        return true;
    }

    private isRefusedUpdate(error: unknown): boolean {
        return error instanceof postgres.PostgresError && error.code.startsWith(DATA_EXCEPTION_CLASS);
    }

    // An update without a session key is dropped, as HasSessionKeyFilter drops it from the pipeline:
    // the inbox stores none (docs/architecture/inbox.md, "Updates without a session key").
    private toInputs(updates: Update[], me: UserFromGetMe): InboxUpdateInput[] {
        const inputs: InboxUpdateInput[] = [];

        for (const update of updates) {
            const group = this.findGroup(update, me);

            if (group === undefined) {
                this.logger.warning("Update is dropped, because its session key cannot be resolved.", { updateId: update.update_id });

                continue;
            }

            inputs.push({ userId: group.userId, chatId: group.chatId, update: update });
        }

        return inputs;
    }

    // The pair getSessionKey() makes the session key of, read off the Context of grammY as session()
    // reads it: the group is the session key (docs/architecture/inbox.md, "Tables"), whatever the type
    // of the update.
    private findGroup(update: Update, me: UserFromGetMe): InboxGroupKey | undefined {
        const ctx = new Context(update, this.api, me);

        if (ctx.from === undefined || ctx.chat === undefined) {
            return undefined;
        }

        return { userId: ctx.from.id, chatId: ctx.chat.id };
    }

    private logStoreFailure(inputs: InboxUpdateInput[], error: unknown): void {
        this.logger.error("Storing updates failed, the source gets them again from the same offset.", {
            updateIds: inputs.map((input) => input.update.update_id),
            cause: error,
        });
    }

    // A call the stop aborted is not a failure. The error goes through the serializer: the fetch error
    // an HttpError wraps names the URL of the call, and the URL carries the bot token.
    private logCallFailure(message: string, error: unknown, payload: UnknownObject): void {
        if (this.isStopped()) {
            return;
        }

        this.logger.error(message, { ...payload, cause: this.errorSerializer.serialize(error) });
    }

    // pauseFor() rejects only with the AbortError of the stop, which ends the pause.
    private async pause(): Promise<void> {
        await pauseFor(this.retryPauseMs, undefined, { signal: this.stopController.signal }).catch(() => undefined);
    }

    private isStopped(): boolean {
        return this.stopController.signal.aborted;
    }
}
