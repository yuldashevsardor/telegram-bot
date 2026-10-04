// Who takes the items of a loop, written into every attempt the loop makes: the node, and the loop
// among the restarts of the process. workerId names the loop, not one of its slots.
export type LoopWorker = {
    host: string;
    pid: number;
    workerId: string;
};

// The items of a loop: one generator for the worker of the loop, which ends after stop(). It hands
// out what a fetch in progress has got before it ends, so no item is left taken by nobody.
export interface WorkItemSource<Item> {
    stream(worker: LoopWorker): AsyncGenerator<Item, void, undefined>;
    stop(): void;
}

// Takes one item to its outcome. signal aborts the work when the node stops past the deadline of the
// stop; the processor settles the item then (docs/architecture/outbox.md, "The runner").
export interface WorkItemProcessor<Item> {
    process(item: Item, signal: AbortSignal): Promise<void>;
}
