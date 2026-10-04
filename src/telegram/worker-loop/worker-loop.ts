import { injectable } from "inversify";
import { withTimeout } from "app/shared/utils";
import type { LoopWorker, WorkItemProcessor, WorkItemSource } from "app/telegram/worker-loop/worker-loop.types";

// The work of a node: one loop over a number of slots, each processing one item at a time
// (docs/architecture/outbox.md, "The runner"). The loop writes no outcome: the processor does. A
// subclass names the source, the processor, the slots, the stop deadline and the worker, and logs an
// item whose processing threw.
@injectable()
export abstract class WorkerLoop<Item> {
    protected abstract readonly source: WorkItemSource<Item>;
    protected abstract readonly processor: WorkItemProcessor<Item>;
    // How many items the loop processes at once.
    protected abstract readonly concurrency: number;
    // How long the stop waits for the items in flight before it aborts them.
    protected abstract readonly stopTimeoutMs: number;
    protected abstract readonly worker: LoopWorker;

    // An item in flight by the controller that aborts it; the promise settles once the processor has
    // written its outcome or released it, and never rejects.
    private readonly callsInFlight = new Map<AbortController, Promise<void>>();
    // Ends the latest wait of a loop with every slot busy: a call that settles or the stop calls it,
    // and a call after the wait has ended changes nothing. One resolver per wait: a race with a
    // promise pending until the stop would leave a reaction on it per wait, and the heap would grow
    // with every item processed.
    private wakeUpRunner: (() => void) | undefined;
    private isStopping = false;
    // When stop() aborts the calls in flight; none before the stop.
    private stopDeadlineAtMs = Number.POSITIVE_INFINITY;
    private runCompletion: Promise<void> = Promise.resolve();

    // Called once: a source serves one generator (docs/architecture/invariants.md, "The outbox").
    public start(): void {
        this.runCompletion = this.run();
    }

    // Stops taking items, waits for the calls in flight up to stopTimeoutMs from the call, then
    // aborts the rest and waits until they settle: the processor releases an aborted call, so
    // another node takes its item at once.
    public async stop(): Promise<void> {
        this.stopDeadlineAtMs = Date.now() + this.stopTimeoutMs;
        this.isStopping = true;
        this.wakeUpRunner?.();
        this.source.stop();

        // A fetch in progress hands out its item before the loop ends, and the loop starts it: left
        // unprocessed, the item would wait for the recovery of its lease. Past the deadline it starts
        // aborted (startCall()).
        await this.runCompletion;

        // No call starts after the loop has ended, so one wait covers the calls both before and after
        // the abort.
        const callsSettled = Promise.all(this.callsInFlight.values());
        const haveCallsSettled = await withTimeout(callsSettled, this.stopDeadlineAtMs - Date.now());

        // Stryker disable next-line ConditionalExpression,BlockStatement: `false` and `{}` — a settled call has already left callsInFlight (its finally runs before the promise the wait holds), so the abort loop below walks an empty map and the final await resolves at once.
        if (haveCallsSettled) {
            return;
        }

        for (const abortController of this.callsInFlight.keys()) {
            abortController.abort();
        }

        await callsSettled;
    }

    // An item whose processing threw: the processor wrote no outcome, and the item waits for the
    // recovery of its lease.
    protected abstract logUnfinished(item: Item, error: unknown): void;

    private async run(): Promise<void> {
        for await (const item of this.source.stream(this.worker)) {
            this.startCall(item);
            await this.waitForFreeSlotOrStop();

            if (this.isStopping) {
                return;
            }
        }
    }

    // Returns at once while a slot is free.
    private async waitForFreeSlotOrStop(): Promise<void> {
        while (!this.isStopping && this.callsInFlight.size >= this.concurrency) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.wakeUpRunner = resolve;

            await promise;
        }
    }

    // An item taken is started at once: its lease counts from the moment it was taken.
    private startCall(item: Item): void {
        const abortController = new AbortController();

        // A fetch in progress at the stop handed the item out after the deadline: started aborted, the
        // call settles without doing its work, and the item is released rather than started and cut
        // short on the next tick.
        if (Date.now() >= this.stopDeadlineAtMs) {
            abortController.abort();
        }
        const settled = this.processor
            .process(item, abortController.signal)
            .catch((error: unknown) => {
                this.logUnfinished(item, error);
            })
            .finally(() => {
                this.callsInFlight.delete(abortController);
                this.wakeUpRunner?.();
            });

        this.callsInFlight.set(abortController, settled);
    }
}
