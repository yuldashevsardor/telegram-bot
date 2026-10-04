import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// The runner asks for the next message only once it has a free slot.
const PULL_LIMIT = 1;
// The range of the random cap of a sleep. The cap keeps nextPullInMs within a Node timer and stops
// a spin on an answer of zero. Being random, it spreads out the nodes that sleep the whole cap
// together, as the ones that skipped the same held chat do.
const MIN_SLEEP_CAP_MS = 100;
const MAX_SLEEP_CAP_MS = 1_000;

// The messages of the outbox for the runner of this node: one generator that pulls, and sleeps
// when there is nothing to pull. The source serves one generator only (docs/architecture/outbox.md,
// "The message source").
@injectable()
export class OutboxMessageSource {
    private isStopped = false;
    // Counts the ready notifications: a notification that comes while the generator pulls finds it
    // awake, and the pull may have read the tables before the push it announces committed.
    private readyNotificationCount = 0;
    // The sleep of the generator, cut short by stop() and, unless it follows a failed pull, by a ready
    // notification. undefined while the generator is awake.
    private currentSleep: { wakeUp: () => void; shouldWakeOnReady: boolean } | undefined;

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly random: () => number = Math.random,
    ) {}

    // Yields the messages pulled for worker, one per pull, and pulls again when the loop asks for the
    // next one. Ends after stop(): at once from a sleep, and after it has handed out what a pull in
    // progress has got, so no pulled message is left leased to nobody.
    public async *stream(worker: OutboxWorker): AsyncGenerator<PulledOutboxMessage, void, undefined> {
        // After stop() the database may be closed already, and a LISTEN started then opens a
        // connection that nothing closes.
        if (this.isStopped) {
            return;
        }

        this.listen();

        while (!this.isStopped) {
            const readyNotificationCountBeforePull = this.readyNotificationCount;
            const pullResult = await this.pull(worker);

            // Not cut short by a notification, during the failed pull or the sleep: pushes do not
            // stop while the pulls fail, and the generator would retry and log at their rate.
            if (pullResult === undefined) {
                await this.sleep(this.randomCapMs(), { shouldWakeOnReady: false });

                continue;
            }

            if (pullResult.messages.length > 0) {
                yield* pullResult.messages;

                continue;
            }

            if (this.readyNotificationCount !== readyNotificationCountBeforePull) {
                continue;
            }

            await this.sleep(this.sleepDurationMs(pullResult.nextPullInMs), { shouldWakeOnReady: true });
        }
    }

    // Ends the generator: a sleeping one at once, a pulling one once it has handed out what the pull
    // got, and one made afterwards at once. The loop sends the messages it holds: the stop of the
    // calls in flight is the loop's.
    public stop(): void {
        this.isStopped = true;
        this.currentSleep?.wakeUp();
    }

    // undefined: the pull failed. It is left to the next one: the source ends only on stop(). A pull
    // that fails after stop() has no next one, and the database may have been closed under it.
    private async pull(worker: OutboxWorker): Promise<OutboxPullResult | undefined> {
        try {
            return await this.store.pull(PULL_LIMIT, worker);
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
    // zero after a pull that got nothing means that another transaction holds a due chat, or that
    // the pull waited behind a pull that held the bot row longer than the common cooldown
    // (docs/architecture/outbox.md, "Pull"): both sleep the whole cap.
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

    // Started once, by the generator, and not repeated for the reason OutboxResultWaiter.listen()
    // gives. Until the listening starts, the capped sleep serves. A start that fails after stop() is
    // not logged: the database may have been closed under it by a clean shutdown.
    private listen(): void {
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
        // Stryker disable next-line AssignmentOperator: `-=` is equivalent: the generator only compares the count before and after a pull
        this.readyNotificationCount += 1;

        if (this.currentSleep?.shouldWakeOnReady === true) {
            this.currentSleep.wakeUp();
        }
    }
}
