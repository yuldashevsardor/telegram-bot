import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { ClaimedInboxUpdate, InboxWorker } from "app/telegram/inbox/store/inbox-store.types";

// The runner asks for the next update only once it has a free slot. At the stop the runner starts the
// one update it has got and closes the generator, so a larger claim would leave the rest claimed by
// the stopping node until their lease passes.
const CLAIM_LIMIT = 1;
// The range of the random sleep after a claim that got nothing. A claim answers with no time to wait
// for: the end of a retry delay notifies no one, so the sleep is how a node learns of it. Being random,
// it spreads out the nodes that found nothing together.
const MIN_SLEEP_MS = 100;
const MAX_SLEEP_MS = 1_000;

// The updates of the inbox for the runner of this node: one generator that claims, and sleeps when
// there is nothing to claim. The source serves one generator only (docs/architecture/inbox.md, "The
// update source").
@injectable()
export class InboxUpdateSource {
    private isStopped = false;
    // Counts the ready notifications: a notification that comes while the generator claims finds it
    // awake, and the claim may have read the tables before the write it announces committed.
    private readyNotificationCount = 0;
    // The sleep of the generator, cut short by stop() and, unless it follows a failed claim, by a ready
    // notification. undefined while the generator is awake.
    private currentSleep: { wakeUp: () => void; shouldWakeOnReady: boolean } | undefined;

    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly random: () => number = Math.random,
    ) {}

    // Yields the updates claimed for worker, one per claim, and claims again when the loop asks for the
    // next one. Ends after stop(): at once from a sleep, and after it has handed out what a claim in
    // progress has got, so no claimed update is left leased to nobody. Never throws: a failed claim is
    // logged and retried.
    public async *stream(worker: InboxWorker): AsyncGenerator<ClaimedInboxUpdate, void, undefined> {
        // After stop() the database may be closed already, and a LISTEN started then opens a
        // connection that nothing closes.
        if (this.isStopped) {
            return;
        }

        this.listen();

        while (!this.isStopped) {
            const readyNotificationCountBeforeClaim = this.readyNotificationCount;
            const claimedUpdates = await this.claim(worker);

            // Not cut short by a notification, during the failed claim or the sleep: pushes do not
            // stop while the claims fail, and the generator would retry and log at their rate.
            if (claimedUpdates === undefined) {
                await this.sleep({ shouldWakeOnReady: false });

                continue;
            }

            if (claimedUpdates.length > 0) {
                yield* claimedUpdates;

                continue;
            }

            if (this.readyNotificationCount !== readyNotificationCountBeforeClaim) {
                continue;
            }

            await this.sleep({ shouldWakeOnReady: true });
        }
    }

    // Ends the generator: a sleeping one at once, a claiming one once it has handed out what the claim
    // got, and one made afterwards at once. The loop handles the update it holds: the stop of the
    // handlers in flight is the loop's.
    public stop(): void {
        this.isStopped = true;
        this.currentSleep?.wakeUp();
    }

    // undefined: the claim failed. It is left to the next one: the source ends only on stop(). A claim
    // that fails after stop() has no next one, and the database may have been closed under it.
    private async claim(worker: InboxWorker): Promise<ClaimedInboxUpdate[] | undefined> {
        try {
            return await this.store.claim(CLAIM_LIMIT, worker);
        } catch (error) {
            if (this.isStopped) {
                this.logger.warning("Claiming inbox updates failed after the stop.", { worker: worker, cause: error });
            } else {
                this.logger.error("Claiming inbox updates failed, the next claim tries again.", { worker: worker, cause: error });
            }

            return undefined;
        }
    }

    // Cut short by stop(), and by a ready notification if shouldWakeOnReady. Not started after stop().
    private async sleep(options: { shouldWakeOnReady: boolean }): Promise<void> {
        if (this.isStopped) {
            return;
        }

        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, MIN_SLEEP_MS + this.random() * (MAX_SLEEP_MS - MIN_SLEEP_MS));
        this.currentSleep = { wakeUp: resolve, shouldWakeOnReady: options.shouldWakeOnReady };

        await promise;

        clearTimeout(timer);
        this.currentSleep = undefined;
    }

    // Started once, by the generator, and not repeated: postgres.js subscribes the listener again when
    // its listening connection closes (docs/architecture/outbox.md, "Waiting for the result"). Until
    // the listening starts, the timed sleep serves. A start that fails after stop() is not logged: the
    // database may have been closed under it by a clean shutdown.
    private listen(): void {
        this.store
            .listenReady(() => this.onReady())
            .catch((error: unknown) => {
                if (this.isStopped) {
                    return;
                }

                this.logger.warning(
                    "Listening for ready inbox groups failed, the source claims on the timed sleep until the listening starts.",
                    {
                        cause: error,
                    },
                );
            });
    }

    private onReady(): void {
        // Stryker disable next-line AssignmentOperator: `-=` is equivalent: the generator only compares the count before and after a claim
        this.readyNotificationCount += 1;

        if (this.currentSleep?.shouldWakeOnReady === true) {
            this.currentSleep.wakeUp();
        }
    }
}
