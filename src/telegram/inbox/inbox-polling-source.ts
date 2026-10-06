import { setTimeout as pauseFor } from "node:timers/promises";
import type { Api } from "grammy";
import { Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { inject, injectable } from "inversify";
import postgres from "postgres";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import { RuntimeError } from "app/shared/errors";
import { MS_PER_SECOND } from "app/shared/time";
import type { Logger } from "app/platform/logger/logger";
import { ALLOWED_UPDATES } from "app/telegram/bot/bot";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { InboxApiFactory } from "app/telegram/inbox/inbox-api-factory";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxGroupKey, InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import type { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import { hasSessionKey } from "app/telegram/session/session.helper";

// How long getUpdates waits for an update before it answers with none.
const POLL_TIMEOUT_SECONDS = 30;
// How long the answer of a getUpdates may take beyond the long poll.
const ANSWER_MARGIN_SECONDS = 10;
// The most updates the Bot API gives in one getUpdates: a backlog drains in as few inserts as it can.
const POLL_LIMIT = 100;
// The SQLSTATE codes PostgreSQL refuses the values of an update in jsonb with, and the same update
// fails every time it is pushed: untranslatable_character for a \u0000 escape and
// invalid_text_representation for a lone surrogate. Not the whole class 22 of data exceptions: a
// change of the store that fails every row with another of them would drop every update instead of
// stalling the source.
const REFUSED_UPDATE_SQLSTATES: ReadonlySet<string> = new Set(["22P05", "22P02"]);
// The character jsonb refuses in a string; a lone surrogate is the other value it refuses.
const NUL_CHARACTER = "\u0000";

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
    private readonly api: Api;
    private isStarted = false;
    private runCompletion: Promise<void> = Promise.resolve();
    // The failed calls and inserts in a row: the pause after each grows with them.
    private consecutiveFailureCount = 0;

    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<InboxApiFactory>(Tokens.Bot.Inbox.ApiFactory) apiFactory: InboxApiFactory,
        @inject<RetryDelay>(Tokens.Bot.RetryDelay) private readonly retryDelay: RetryDelay,
        @inject<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier)
        private readonly botApiClassifier: TelegramBotApiFailureClassifier,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {
        this.api = apiFactory.create(POLL_TIMEOUT_SECONDS + ANSWER_MARGIN_SECONDS);
    }

    // Called once: a second loop would poll the same bot and get 409 from Telegram. The loop catches
    // every failure it expects; one it does not stops the polling with a critical log rather than
    // leaving an unhandled rejection.
    public start(): void {
        if (this.isStarted) {
            throw new RuntimeError("Inbox polling source is already started!");
        }

        this.isStarted = true;
        this.runCompletion = this.run().catch((error: unknown) => {
            this.logger.critical("The inbox polling stopped on an unexpected error.", { cause: error });
        });
    }

    // No getUpdates after it: the call in flight is aborted, and an insert in flight is awaited, so
    // the updates it got are stored. Telegram learns the offset of the last batch only from the next
    // getUpdates, so the next start gets that batch again, and the push leaves out what it stored.
    // No deadline of its own: an insert stuck on the database holds it, and the shutdown bounds it.
    public async stop(): Promise<void> {
        this.stopController.abort();

        await this.runCompletion;
    }

    private async run(): Promise<void> {
        const me = await this.prepare();

        if (me === undefined) {
            return;
        }

        // Lower than any update_id: Telegram answers it from the first update it has not been told of. An
        // update is told of by a getUpdates with an offset past it, and never comes again. So a restart
        // gets again only the last batch before the stop, which no getUpdates has told of, and the
        // push leaves out the updates of it stored already: the inbox gets no duplicate
        // (docs/architecture/inbox.md, "The polling source").
        let offset = 0;

        while (!this.isStopped()) {
            const updates = await this.getUpdates(offset);

            if (updates === undefined) {
                continue;
            }

            const isStored = await this.storeUpdates(updates, me);

            if (!isStored) {
                continue;
            }

            this.consecutiveFailureCount = 0;
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
                const me = await this.api.getMe(this.apiSignal);
                this.consecutiveFailureCount = 0;

                return me;
            } catch (error) {
                this.logCallFailure("Preparing the polling failed, the source tries again.", error, {});
                await this.pauseAfterFailure(error);
            }
        }

        return undefined;
    }

    // undefined: the call failed, and the pause after it is over, or the stop aborted it.
    private async getUpdates(offset: number): Promise<Update[] | undefined> {
        try {
            return await this.api.getUpdates(
                { offset: offset, limit: POLL_LIMIT, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ALLOWED_UPDATES },
                this.apiSignal,
            );
        } catch (error) {
            this.logCallFailure("Getting updates failed, the source tries again from the same offset.", error, { offset: offset });
            await this.pauseAfterFailure(error);

            return undefined;
        }
    }

    // false: not every update is stored or dropped, and the batch is to be got again from the same
    // offset once the pause after the failure is over; the updates stored already are left out by
    // the push.
    private async storeUpdates(updates: Update[], me: UserFromGetMe): Promise<boolean> {
        const inputs = this.toInputs(updates, me);

        try {
            await this.store.pushBatch(inputs);

            return true;
        } catch (error) {
            if (!this.isRefusal(error, inputs)) {
                await this.handleStoreFailure(inputs, error);

                return false;
            }

            return await this.pushOneByOne(inputs);
        }
    }

    // pushBatch() stores the batch in one statement, so one refused update rolls back the others, and
    // every retry from the same offset fails on it again. One at a time, the others go in, and the
    // refused one is dropped.
    private async pushOneByOne(inputs: InboxUpdateInput[]): Promise<boolean> {
        for (const [index, input] of inputs.entries()) {
            try {
                await this.store.push(input);
            } catch (error) {
                // The ones before it are stored or dropped already.
                if (!this.isRefusal(error, [input])) {
                    await this.handleStoreFailure(inputs.slice(index), error);

                    return false;
                }

                // Not the error as a whole: the CONTEXT PostgreSQL gives it, in its where field, holds
                // the update up to the refused value, the text of the message included.
                this.logger.error("The inbox refused an update, it is dropped.", {
                    updateId: input.update.update_id,
                    code: error.code,
                    message: error.message,
                    detail: error.detail,
                });
            }
        }

        return true;
    }

    // A failure the updates themselves cause: one of the refusal codes, and a value jsonb refuses in
    // one of the updates. 22P02 is the code of any malformed input, so a store change that broke every
    // row would give it too, and the code alone would drop every update.
    private isRefusal(error: unknown, inputs: InboxUpdateInput[]): error is postgres.PostgresError {
        if (!(error instanceof postgres.PostgresError) || !REFUSED_UPDATE_SQLSTATES.has(error.code)) {
            return false;
        }

        return inputs.some((input) => this.holdsValueJsonbRefuses(input.update));
    }

    // A string with a NUL character or a lone surrogate anywhere in the value.
    private holdsValueJsonbRefuses(value: unknown): boolean {
        if (typeof value === "string") {
            return value.includes(NUL_CHARACTER) || !value.isWellFormed();
        }

        if (typeof value !== "object" || value === null) {
            return false;
        }

        return Object.values(value).some((nested) => this.holdsValueJsonbRefuses(nested));
    }

    private toInputs(updates: Update[], me: UserFromGetMe): InboxUpdateInput[] {
        const inputs: InboxUpdateInput[] = [];

        for (const update of updates) {
            const group = this.findGroup(update, me);

            if (group === undefined) {
                continue;
            }

            inputs.push({ userId: group.userId, chatId: group.chatId, update: update });
        }

        return inputs;
    }

    // The pair getSessionKey() makes the session key of, read off the Context of grammY as session()
    // reads it: the group is the session key (docs/architecture/inbox.md, "Tables"), whatever the type
    // of the update. undefined: the update has no session key and is dropped, with the warning
    // HasSessionKeyFilter gives it in the pipeline; the inbox stores none (docs/architecture/inbox.md,
    // "Updates without a session key"). The contents of the update stay out of the log.
    private findGroup(update: Update, me: UserFromGetMe): InboxGroupKey | undefined {
        const ctx = new Context(update, this.api, me);

        if (!hasSessionKey(ctx)) {
            this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
                updateId: update.update_id,
                hasFrom: ctx.from !== undefined,
                hasChat: ctx.chat !== undefined,
            });

            return undefined;
        }

        return { userId: ctx.from.id, chatId: ctx.chat.id };
    }

    // inputs: the updates not stored.
    private async handleStoreFailure(inputs: InboxUpdateInput[], error: unknown): Promise<void> {
        this.logger.error("Storing updates failed, the source gets them again from the same offset.", {
            updateIds: inputs.map((input) => input.update.update_id),
            cause: error,
        });
        await this.pauseAfterFailure(error);
    }

    // A call the stop aborted is not a failure.
    private logCallFailure(message: string, error: unknown, payload: UnknownObject): void {
        if (this.isStopped()) {
            return;
        }

        this.logger.error(message, { ...payload, cause: error });
    }

    // The retry delay for the failures in a row, so an outage of Telegram, a revoked
    // token or a lasting 409 is not retried and logged every second; or the wait a 429 asks for, if it
    // is longer.
    private async pauseAfterFailure(error: unknown): Promise<void> {
        this.consecutiveFailureCount += 1;

        const retryDelayMs = this.retryDelay.computeMs(this.consecutiveFailureCount);
        const failure = this.botApiClassifier.classify(error);

        if (failure.kind === TelegramBotApiFailureKind.Flood) {
            await this.pause(Math.max(retryDelayMs, failure.retryAfterSeconds * MS_PER_SECOND));

            return;
        }

        await this.pause(retryDelayMs);
    }

    // Cut short by the stop. Protected for the spec, which records the durations instead of waiting.
    // pauseFor() rejects only with the AbortError of the stop, which ends the pause.
    protected async pause(durationMs: number): Promise<void> {
        await pauseFor(durationMs, undefined, { signal: this.stopController.signal }).catch(() => undefined);
    }

    private isStopped(): boolean {
        return this.stopController.signal.aborted;
    }
}
