import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The range of the random cap of a sleep. The cap keeps nextPullInMs within a Node timer and stops
// a spin on an answer of zero. Being random, it spreads out the sources of the nodes that sleep the
// whole cap together, as the ones that lost the bot row to the same pull do.
const MIN_SLEEP_CAP_MS = 100;
const MAX_SLEEP_CAP_MS = 1_000;

// The messages of the outbox for the worker loop of this node: one pull per call, for as many
// messages as the loop has free slots, and a sleep when there is nothing to pull
// (docs/architecture/outbox.md, "The message source").
@injectable()
export class OutboxMessageSource {
    private isStopped = false;
    private hasStartedListening = false;
    // Counts the ready notifications: a notification that comes during a pull finds the source
    // awake, and the pull may have read the tables before the push it announces committed.
    private readyNotificationCount = 0;
    // The sleep in progress, for stop() and the ready notifications. The source serves one caller,
    // the worker loop of the node, so it sleeps at most once at a time.
    private currentSleep: { wakeUp: () => void; shouldWakeOnReady: boolean } | undefined;

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly random: () => number = Math.random,
    ) {}

    // Pulls up to limit messages for worker and returns them. A pull that got nothing or failed
    // sleeps first and returns none: the caller calls again. After stop() returns none at once,
    // without a pull, so the caller tells its own stop from an empty pull; a pull in progress on
    // stop() returns what it got, so no pulled message is left leased to nobody. One call at a
    // time, with a limit from 1 (docs/architecture/outbox.md, "The message source").
    public async next(limit: number, worker: OutboxWorker): Promise<PulledOutboxMessage[]> {
        // After stop() the database may be closed already, and a LISTEN started then opens a
        // connection that nothing closes.
        if (this.isStopped) {
            return [];
        }

        this.listen();

        const readyNotificationCountBeforePull = this.readyNotificationCount;
        const pullResult = await this.pull(limit, worker);

        // Not cut short by a notification, during the failed pull or the sleep: pushes do not
        // stop while the pulls fail, and the source would retry and log at their rate.
        if (pullResult === undefined) {
            await this.sleep(this.randomCapMs(), { shouldWakeOnReady: false });

            return [];
        }

        if (pullResult.messages.length > 0) {
            return pullResult.messages;
        }

        if (this.readyNotificationCount !== readyNotificationCountBeforePull) {
            return [];
        }

        await this.sleep(this.sleepDurationMs(pullResult.nextPullInMs), { shouldWakeOnReady: true });

        return [];
    }

    // Ends a sleep in progress at once, and every call of next() afterwards returns none without a
    // pull. A pull in progress returns what it got: the caller starts those messages, and the stop
    // of the calls in flight is the caller's.
    public stop(): void {
        this.isStopped = true;
        this.currentSleep?.wakeUp();
    }

    // undefined: the pull failed. It is left to the next one: the pulls go on until stop(). A pull
    // that fails after stop() has no next one, and the database may have been closed under it.
    private async pull(limit: number, worker: OutboxWorker): Promise<OutboxPullResult | undefined> {
        try {
            return await this.store.pull(limit, worker);
        } catch (error) {
            if (this.isStopped) {
                this.logger.warning("Pulling outbox messages failed after the stop.", { worker: worker, cause: error });
            } else {
                this.logger.error("Pulling outbox messages failed, the next pull tries again.", { worker: worker, cause: error });
            }

            return undefined;
        }
    }

    // nextPullInMs, capped by randomCapMs(). A null answer has no time to wait for, and an answer of
    // zero after a pull that got nothing means that another transaction holds the bot row or a due
    // chat: both sleep the whole cap.
    private sleepDurationMs(nextPullInMs: number | null): number {
        const capMs = this.randomCapMs();

        if (nextPullInMs === null || nextPullInMs === 0) {
            return capMs;
        }

        return Math.min(nextPullInMs, capMs);
    }

    private randomCapMs(): number {
        return MIN_SLEEP_CAP_MS + this.random() * (MAX_SLEEP_CAP_MS - MIN_SLEEP_CAP_MS);
    }

    // Cut short by stop(), and by a ready notification if shouldWakeOnReady. Not started after stop().
    private async sleep(durationMs: number, options: { shouldWakeOnReady: boolean }): Promise<void> {
        if (this.isStopped) {
            return;
        }

        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, durationMs);
        this.currentSleep = { wakeUp: resolve, shouldWakeOnReady: options.shouldWakeOnReady };

        await promise;

        clearTimeout(timer);
        this.currentSleep = undefined;
    }

    // Started once, by the first call of next(), for the reason OutboxResultWaiter.listen() gives.
    // Until the listening starts, the capped sleep serves. A start that fails after stop() is not
    // logged: the database may have been closed under it by a clean shutdown.
    private listen(): void {
        if (this.hasStartedListening) {
            return;
        }

        this.hasStartedListening = true;

        this.store
            .listenReady(() => this.onReady())
            .catch((error: unknown) => {
                if (this.isStopped) {
                    return;
                }

                this.logger.warning(
                    "Listening for ready outbox messages failed, the source pulls on the capped sleep until the listening starts.",
                    {
                        cause: error,
                    },
                );
            });
    }

    private onReady(): void {
        this.readyNotificationCount += 1;

        if (this.currentSleep?.shouldWakeOnReady === true) {
            this.currentSleep.wakeUp();
        }
    }
}
