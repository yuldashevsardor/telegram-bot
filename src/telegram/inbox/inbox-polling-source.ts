import { setTimeout as pauseFor } from "node:timers/promises";
import type { Api } from "grammy";
import { Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { UnknownObject } from "app/shared/types";
import { RuntimeError } from "app/shared/errors";
import { MAX_TIMER_DELAY_MS, MS_PER_SECOND } from "app/shared/time";
import type { Logger } from "app/platform/logger/logger";
import { ALLOWED_UPDATES } from "app/telegram/bot/bot.types";
import type { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { TelegramApiFactory } from "app/telegram/telegram-api-factory";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import { InboxUpdateRefused } from "app/telegram/inbox/store/inbox-store.errors";
import type { InboxUpdateInput } from "app/telegram/inbox/store/inbox-store.types";
import type { RetryDelay } from "app/telegram/retry-delay/retry-delay";
import { hasSessionKey } from "app/telegram/session/session.helper";

// How long getUpdates waits for an update before it answers with none.
const POLL_TIMEOUT_SECONDS = 30;
// How long the answer of a getUpdates may take beyond the long poll.
const ANSWER_MARGIN_SECONDS = 10;
// The most updates the Bot API gives in one getUpdates: a backlog drains in as few inserts as it can.
const POLL_LIMIT = 100;

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
        @inject<TelegramApiFactory>(Tokens.Bot.ApiFactory) apiFactory: TelegramApiFactory,
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

        // Lower than any update_id: Telegram answers it from the first update it has not been told of,
        // so a restart gets the last batch again, and the push leaves out its stored updates
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
                await this.pauseAfterCallFailure(error);
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
            await this.pauseAfterCallFailure(error);

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
            if (!(error instanceof InboxUpdateRefused)) {
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
            // The stop waits for the push in flight, not for the rest of the batch: the next start gets
            // it again.
            if (this.isStopped()) {
                return false;
            }

            try {
                await this.store.push(input);
            } catch (error) {
                // The ones before it are stored or dropped already.
                if (!(error instanceof InboxUpdateRefused)) {
                    await this.handleStoreFailure(inputs.slice(index), error);

                    return false;
                }

                this.logger.error("The inbox refused an update, it is dropped.", { updateId: input.update.update_id, cause: error });
            }
        }

        return true;
    }

    // The group of an update is the pair getSessionKey() makes the session key of, read off the
    // Context of grammY as session() reads it: the group is the session key
    // (docs/architecture/inbox.md, "Tables"), whatever the type of the update. An update without a
    // session key is dropped with the warning HasSessionKeyFilter gives it in the pipeline; the inbox
    // stores none (docs/architecture/inbox.md, "Updates without a session key"). The contents of the
    // update stay out of the log.
    private toInputs(updates: Update[], me: UserFromGetMe): InboxUpdateInput[] {
        const inputs: InboxUpdateInput[] = [];

        for (const update of updates) {
            const ctx = new Context(update, this.api, me);

            if (!hasSessionKey(ctx)) {
                this.logger.warning("Update is dropped, because its session key cannot be resolved.", {
                    updateId: update.update_id,
                    hasFrom: ctx.from !== undefined,
                    hasChat: ctx.chat !== undefined,
                });

                continue;
            }

            inputs.push({ userId: ctx.from.id, chatId: ctx.chat.id, update: update });
        }

        return inputs;
    }

    // inputs: the updates not stored. A push that fails after the stop has no retry: the next start
    // gets the updates again.
    private async handleStoreFailure(inputs: InboxUpdateInput[], error: unknown): Promise<void> {
        const payload = { updateIds: inputs.map((input) => input.update.update_id), cause: error };

        if (this.isStopped()) {
            this.logger.warning("Storing updates failed after the stop, the next start gets them again.", payload);

            return;
        }

        this.logger.error("Storing updates failed, the source gets them again from the same offset.", payload);
        await this.pauseAfterStoreFailure();
    }

    // A call the stop aborted is not a failure.
    private logCallFailure(message: string, error: unknown, payload: UnknownObject): void {
        if (this.isStopped()) {
            return;
        }

        this.logger.error(message, { ...payload, cause: error });
    }

    // The retry delay, or the wait a 429 asks for, if it is longer.
    private async pauseAfterCallFailure(error: unknown): Promise<void> {
        const retryDelayMs = this.countFailureAndGetRetryDelayMs();
        const failure = this.botApiClassifier.classify(error);

        if (failure.kind === TelegramBotApiFailureKind.Flood) {
            const floodWaitMs = Math.max(retryDelayMs, failure.retryAfterSeconds * MS_PER_SECOND);

            await this.pause(Math.min(floodWaitMs, MAX_TIMER_DELAY_MS));

            return;
        }

        await this.pause(retryDelayMs);
    }

    // The retry delay alone: a 429 comes from Telegram, so the Bot API classifier has no say over a
    // failure of the store.
    private async pauseAfterStoreFailure(): Promise<void> {
        await this.pause(this.countFailureAndGetRetryDelayMs());
    }

    // The failures in a row are counted for calls and pushes alike, and the retry delay grows with
    // them, so an outage of Telegram, a revoked token or a lasting 409 is not retried and logged every
    // second.
    private countFailureAndGetRetryDelayMs(): number {
        this.consecutiveFailureCount += 1;

        return this.retryDelay.computeMs(this.consecutiveFailureCount);
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
