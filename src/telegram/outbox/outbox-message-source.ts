import { inject, injectable } from "inversify";
import type { Logger } from "app/platform/logger/logger";
import { Tokens } from "app/shared/tokens";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxPullResult, OutboxWorker, PulledOutboxMessage } from "app/telegram/outbox/store/outbox-store.types";

// A generator serves one worker, and the worker asks for the next message only once it is free.
const PULL_LIMIT = 1;
// The range of the random cap of a sleep. The cap keeps nextPullInMs within a Node timer and stops
// a spin on an answer of zero; being random, it keeps the sources of a node and of the other nodes
// from pulling in step.
const MIN_SLEEP_CAP_MS = 100;
const MAX_SLEEP_CAP_MS = 1_000;

// The messages of the outbox for the workers of this node: each worker takes them from a generator
// of its own that pulls, and sleeps when there is nothing to pull (docs/architecture/outbox.md,
// "The message source").
@injectable()
export class OutboxMessageSource {
    private isStopped = false;
    private hasStartedListening = false;
    // Counts the ready notifications: a notification that comes while a generator pulls finds it
    // awake, and the pull may have read the tables before the push it announces committed.
    private readyNotificationCount = 0;
    // The wake-ups of the generators that sleep now, for stop().
    private readonly wakeUps = new Set<() => void>();
    // The wake-ups of those a ready notification cuts short: every sleep but one after a failed pull.
    private readonly readyWakeUps = new Set<() => void>();

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
        private readonly random: () => number = Math.random,
    ) {}

    // Yields the messages pulled for worker, one per pull, and pulls again when the worker asks for
    // the next one. Ends after stop(): at once from a sleep, and after it has handed out what a pull
    // in progress has got, so no pulled message is left leased to nobody.
    public async *messages(worker: OutboxWorker): AsyncGenerator<PulledOutboxMessage, void, undefined> {
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
                await this.sleep(this.sleepDurationMs(null), { wakesOnReady: false });

                continue;
            }

            if (pullResult.messages.length > 0) {
                yield* pullResult.messages;

                continue;
            }

            if (this.readyNotificationCount !== readyNotificationCountBeforePull) {
                continue;
            }

            await this.sleep(this.sleepDurationMs(pullResult.nextPullInMs), { wakesOnReady: true });
        }
    }

    // Ends every generator: a sleeping one at once, a pulling one once it has handed out what the
    // pull got, and one generator made afterwards at once. A worker holding a message sends it: the
    // stop of the calls in flight is the worker's.
    public stop(): void {
        this.isStopped = true;
        this.wake(this.wakeUps);
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

    // nextPullInMs, capped by a random point between MIN_SLEEP_CAP_MS and MAX_SLEEP_CAP_MS. A null
    // answer has no time to wait for, and an answer of zero after a pull that got nothing means that
    // another transaction holds the bot row or a due chat: both sleep the whole cap.
    private sleepDurationMs(nextPullInMs: number | null): number {
        const capMs = MIN_SLEEP_CAP_MS + this.random() * (MAX_SLEEP_CAP_MS - MIN_SLEEP_CAP_MS);

        if (nextPullInMs === null || nextPullInMs === 0) {
            return capMs;
        }

        return Math.min(nextPullInMs, capMs);
    }

    // Cut short by stop(), and by a ready notification if wakesOnReady; a sleep after stop() does not
    // start.
    private async sleep(durationMs: number, options: { wakesOnReady: boolean }): Promise<void> {
        if (this.isStopped) {
            return;
        }

        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, durationMs);
        this.wakeUps.add(resolve);

        if (options.wakesOnReady) {
            this.readyWakeUps.add(resolve);
        }

        await promise;

        clearTimeout(timer);
        this.wakeUps.delete(resolve);
        this.readyWakeUps.delete(resolve);
    }

    // Started once, by the first generator, for the reason OutboxResultWaiter.listen() gives. Until
    // the listening starts, the capped sleep serves. A start that fails after stop() is not logged:
    // the database may have been closed under it by a clean shutdown.
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
                    "Listening for ready outbox messages failed, the sources pull on the capped sleep until the listening starts.",
                    {
                        cause: error,
                    },
                );
            });
    }

    // Every generator of the node wakes up: a push may have made several chats ready.
    private onReady(): void {
        this.readyNotificationCount += 1;
        this.wake(this.readyWakeUps);
    }

    private wake(wakeUps: Set<() => void>): void {
        for (const wakeUp of wakeUps) {
            wakeUp();
        }
    }
}
