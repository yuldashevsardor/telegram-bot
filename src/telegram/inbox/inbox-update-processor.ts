import type { Bot as TelegramBot } from "grammy";
import { BotError } from "grammy";
import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { configValue } from "app/shared/config-value";
import type { Logger } from "app/platform/logger/logger";
import type { Bot } from "app/telegram/bot/bot";
import type { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { InboxLeaseExtension } from "app/telegram/inbox/inbox-lease-extension";
import type { InboxLeaseReleaser } from "app/telegram/inbox/inbox-lease-releaser";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate } from "app/telegram/inbox/store/inbox-store.types";
import { OutboxResultWaiterStopped } from "app/telegram/outbox/result-waiter/outbox-result-waiter.errors";

// grammY types the signal of init() by the abort-controller polyfill, which the AbortSignal of Node
// serves at runtime but does not match as a type.
type GrammyAbortSignal = Parameters<TelegramBot["init"]>[0];

// What the handling came to, written to the inbox once the extension of the lease has stopped.
type HandlingOutcome = { kind: "done" } | { kind: "release" } | { kind: "failure"; error: unknown };

// The lease is extended this many times per lease duration: an extension sent well before the lease
// passes is not met by the recovery (docs/architecture/inbox.md, "The lease").
const EXTENSIONS_PER_LEASE = 3;

// Told when the handler of the update starts and when it ends: the stop of the runner waits for an
// update outside its handler, and leaves one in it running.
export type InboxHandlerProgress = {
    onStart: () => void;
    onEnd: () => void;
};

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
    public async process(update: ClaimedInboxUpdate, signal: AbortSignal, handlerProgress: InboxHandlerProgress): Promise<void> {
        const leaseExtension = new InboxLeaseExtension(this.store, this.logger, update, this.leaseExtensionIntervalMs, signal);
        let outcome: HandlingOutcome;

        leaseExtension.start();

        // Stopped before the outcome is written: the completion ends the lease, and an extension that
        // came after it would be refused and logged for nothing.
        try {
            outcome = await this.handle(update, signal, handlerProgress);
        } finally {
            leaseExtension.stop();
        }

        await this.writeOutcome(update, outcome);
    }

    private async handle(update: ClaimedInboxUpdate, signal: AbortSignal, handlerProgress: InboxHandlerProgress): Promise<HandlingOutcome> {
        // A no-op once the bot knows itself: grammY keeps the answer of getMe. init() retries getMe on
        // a network failure until the signal aborts it; one thrown on the abort is released below.
        try {
            await this.bot.grammy.init(signal as GrammyAbortSignal);
        } catch (error) {
            if (!signal.aborted) {
                return { kind: "failure", error: error };
            }
        }

        // An update handed out after the stop deadline, or one whose init() the deadline came during:
        // started now, the handler would run past the stop.
        if (signal.aborted) {
            return { kind: "release" };
        }

        handlerProgress.onStart();

        try {
            await this.bot.grammy.handleUpdate(update.update);
        } catch (error) {
            // A wait the outbox stopped says only that the node is shutting down: handled as a failure,
            // it would block the group of every update in flight on an ordinary restart. The handler
            // has settled, so the release cannot let it reply after the next update of its group.
            if (this.isStoppedOutboxWait(error)) {
                return { kind: "release" };
            }

            return { kind: "failure", error: error };
        } finally {
            handlerProgress.onEnd();
        }

        return { kind: "done" };
    }

    // Not async on purpose: a switch that misses a kind leaves the end of the function reachable,
    // and a function returning a Promise without undefined in it does not compile then.
    private writeOutcome(update: ClaimedInboxUpdate, outcome: HandlingOutcome): Promise<void> {
        switch (outcome.kind) {
            case "done":
                return this.store.markAsDone(update);
            case "release":
                return this.leaseReleaser.releaseOnStop(update);
            case "failure":
                return this.failureHandler.handle(update, outcome.error);
        }
    }

    // The handler's own error, the one grammY wraps into a BotError, as the failure handler reads it.
    private isStoppedOutboxWait(error: unknown): boolean {
        const handlerError = error instanceof BotError ? error.error : error;

        return handlerError instanceof OutboxResultWaiterStopped;
    }
}
