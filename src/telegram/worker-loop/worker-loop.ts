import { injectable } from "inversify";
import { withTimeout } from "app/shared/utils";
import type { WorkerIdentity } from "app/telegram/worker-loop/worker-loop.types";
import type { WorkItemSource } from "app/telegram/worker-loop/work-item-source";
import type { WorkItemProcessor } from "app/telegram/worker-loop/work-item-processor";

// The work of a node: one loop over a number of slots, each processing one item at a time. The loop
// writes no outcome: the processor does. A subclass names the source, the processor, the slots, the
// stop deadline and the worker, and logs an item whose processing rejected.
@injectable()
export abstract class WorkerLoop<Item> {
    protected abstract readonly source: WorkItemSource<Item>;
    protected abstract readonly processor: WorkItemProcessor<Item>;
    // How many items the loop processes at once.
    protected abstract readonly concurrency: number;
    // How long the stop waits for the items in flight before it aborts them.
    protected abstract readonly stopTimeoutMs: number;
    protected abstract readonly worker: WorkerIdentity;

    // An item in flight by the controller that aborts it; the promise settles once the processor has
    // settled the item, and rejects only if logUnfinished() throws.
    private readonly itemsInFlight = new Map<AbortController, Promise<void>>();
    // Ends the latest wait of a loop with every slot busy: an item that settles or the stop calls it,
    // and a call after the wait has ended changes nothing. One resolver per wait: a race with a
    // promise pending until the stop would leave a reaction on it per wait, and the heap would grow
    // with every item processed.
    private wakeUpLoop: (() => void) | undefined;
    private isStopping = false;
    // When stop() aborts the items in flight; none before the stop.
    private stopDeadlineAtMs = Number.POSITIVE_INFINITY;
    private runCompletion: Promise<void> = Promise.resolve();

    // Called once: a source serves one generator (WorkItemSource).
    public start(): void {
        this.runCompletion = this.run();
    }

    // Stops taking items, waits for the items in flight up to stopTimeoutMs from the call, then
    // aborts the rest and waits until they settle.
    public async stop(): Promise<void> {
        this.stopDeadlineAtMs = Date.now() + this.stopTimeoutMs;
        this.isStopping = true;
        this.wakeUpLoop?.();
        this.source.stop();

        // A fetch in progress hands out its item before the generator ends, and the loop starts it:
        // left unprocessed, the item would stay taken by this node. Past the deadline it starts
        // aborted (startItem()).
        await this.runCompletion;

        // No item starts after the loop has ended, so one wait covers the items both before and after
        // the abort.
        const itemsSettled = Promise.all(this.itemsInFlight.values());
        const haveItemsSettled = await withTimeout(itemsSettled, this.stopDeadlineAtMs - Date.now());

        // Stryker disable next-line ConditionalExpression,BlockStatement: `false` and `{}` — a settled item has already left itemsInFlight (its finally runs before the promise the wait holds), so the abort loop below walks an empty map and the final await resolves at once.
        if (haveItemsSettled) {
            return;
        }

        for (const abortController of this.itemsInFlight.keys()) {
            abortController.abort();
        }

        await itemsSettled;
    }

    // An item whose processing rejected: the processor wrote no outcome. Must not throw: the item
    // would reject unhandled, which app.ts logs at critical and ends the process with.
    protected abstract logUnfinished(item: Item, error: unknown): void;

    private async run(): Promise<void> {
        for await (const item of this.source.stream(this.worker)) {
            this.startItem(item);
            await this.waitForFreeSlotOrStop();

            if (this.isStopping) {
                return;
            }
        }
    }

    // Returns at once while a slot is free.
    private async waitForFreeSlotOrStop(): Promise<void> {
        while (!this.isStopping && this.itemsInFlight.size >= this.concurrency) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.wakeUpLoop = resolve;

            await promise;
        }
    }

    // An item handed out is started at once: it does not wait in a queue of the node.
    private startItem(item: Item): void {
        const abortController = new AbortController();

        // A fetch in progress at the stop handed the item out after the deadline: started aborted, the
        // processor settles it without doing its work rather than starting it and having it cut short
        // on the next tick.
        if (Date.now() >= this.stopDeadlineAtMs) {
            abortController.abort();
        }
        const settled = this.processor
            .process(item, abortController.signal)
            .catch((error: unknown) => {
                this.logUnfinished(item, error);
            })
            .finally(() => {
                this.itemsInFlight.delete(abortController);
                this.wakeUpLoop?.();
            });

        this.itemsInFlight.set(abortController, settled);
    }
}
