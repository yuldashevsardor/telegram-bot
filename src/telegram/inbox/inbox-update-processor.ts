import type { Bot as TelegramBot } from "grammy";
import { BotError } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { Bot } from "app/telegram/bot/bot";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import type { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";

// grammY types the signal of init() by the abort-controller polyfill, which the AbortSignal of Node
// serves at runtime but does not match as a type.
type GrammyAbortSignal = Parameters<TelegramBot["init"]>[0];

// The lease is extended this many times per lease duration: an extension sent well before the lease
// passes is not met by the recovery (docs/architecture/inbox.md, "The lease").
const EXTENSIONS_PER_LEASE = 3;

// Takes a claimed update to its outcome: the handler of the bot, with the lease extended while it
// runs, then the outcome written to the inbox (docs/architecture/inbox.md, "The update processor").
@injectable()
export class InboxUpdateProcessor {
    private readonly leaseExtensionIntervalMs: number;

    public constructor(
        @inject<Bot>(Tokens.Bot.Bot) private readonly bot: Bot,
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<InboxFailureHandler>(Tokens.Bot.Inbox.FailureHandler) private readonly failureHandler: InboxFailureHandler,
        @inject<InboxLeaseReleaser>(Tokens.Bot.Inbox.LeaseReleaser) private readonly leaseReleaser: InboxLeaseReleaser,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        leaseDurationMs: number = configValue("inbox.leaseDurationMs"),
    ) {
        this.leaseExtensionIntervalMs = leaseDurationMs / EXTENSIONS_PER_LEASE;
    }

    // signal is aborted when the stop of the node gives up waiting. A handler cannot be cut short, so
    // the abort only keeps an update that has not reached its handler away from it, and ends the
    // extension of the lease. The signal may come aborted already: an update a claim in progress
    // handed out after the stop deadline.
    public async process(update: ClaimedInboxUpdate, signal: AbortSignal): Promise<void> {
        const leaseExtension = this.extendLeaseUntilSettled(update, signal);

        try {
            await this.handle(update, signal);
        } finally {
            leaseExtension.stop();
        }
    }

    private async handle(update: ClaimedInboxUpdate, signal: AbortSignal): Promise<void> {
        // A no-op once the bot knows itself: grammY keeps the answer of getMe. init() retries getMe on
        // a network failure until the signal aborts it.
        try {
            await this.bot.grammy.init(signal as GrammyAbortSignal);
        } catch (error) {
            await this.failBeforeHandler(update, signal, error);
            return;
        }

        // An update handed out after the stop deadline, or one whose init() the deadline came during:
        // started now, the handler would run past the stop.
        if (signal.aborted) {
            await this.leaseReleaser.releaseOnStop(update);
            return;
        }

        try {
            await this.bot.grammy.handleUpdate(update.update);
        } catch (error) {
            // A wait the outbox stopped says only that the node is shutting down: handled as a failure,
            // it would block the group of every update in flight on an ordinary restart. The handler
            // has settled, so the release cannot let it reply after the next update of its group.
            if (this.isStoppedOutboxWait(error)) {
                await this.leaseReleaser.releaseOnStop(update);
                return;
            }

            await this.failureHandler.handle(update, error);
            return;
        }

        await this.store.markAsDone(update);
    }

    // The handler has not run: an init() the stop cut short says nothing about the update.
    private async failBeforeHandler(update: ClaimedInboxUpdate, signal: AbortSignal, error: unknown): Promise<void> {
        if (signal.aborted) {
            await this.leaseReleaser.releaseOnStop(update);
            return;
        }

        await this.failureHandler.handle(update, error);
    }

    // The handler's own error, the one grammY wraps into a BotError, as the failure handler reads it.
    private isStoppedOutboxWait(error: unknown): boolean {
        const handlerError = error instanceof BotError ? error.error : error;

        return handlerError instanceof OutboxResultWaiterStopped;
    }

    // Each extension is timed from the end of the previous one, so two never overlap. A refused one
    // ends the extension: the lease has passed or gone to another claim, and the completion will be
    // fenced. A failed one is left to the next. The abort ends it too: the stop has given the update
    // up, and the database is closed after the stop.
    private extendLeaseUntilSettled(update: ClaimedInboxUpdate, signal: AbortSignal): { stop: () => void } {
        let timer: NodeJS.Timeout | undefined;
        let isStopped = false;

        const stop = (): void => {
            isStopped = true;
            clearTimeout(timer);
        };

        const schedule = (): void => {
            if (isStopped || signal.aborted) {
                return;
            }

            timer = setTimeout(() => void extend(), this.leaseExtensionIntervalMs);
        };

        const extend = async (): Promise<void> => {
            let isExtended: boolean;

            try {
                isExtended = await this.store.extendLease(update);
            } catch (error) {
                if (!isStopped) {
                    this.logger.warning("Extending the lease of an inbox update failed, the next extension tries again.", {
                        updateId: update.updateId,
                        cause: error,
                    });
                }

                schedule();
                return;
            }

            // The update settled during the extension: its completion ends the lease, and a refusal
            // after it says nothing.
            if (isStopped) {
                return;
            }

            if (!isExtended) {
                this.logger.warning("The lease of an inbox update was not extended: it has passed or gone to another claim.", {
                    updateId: update.updateId,
                });
                return;
            }

            schedule();
        };

        signal.addEventListener("abort", stop);
        schedule();

        return { stop: stop };
    }
}
