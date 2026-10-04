// Who takes the items of a loop, written into every attempt the loop makes: the node, and the loop
// among the restarts of the process. workerId names the loop, not one of its slots. OutboxWorker and
// InboxWorker are this type under the names of their stores.
export type LoopWorker = {
    host: string;
    pid: number;
    workerId: string;
};

// The items of a loop. A source serves one generator, so the loop that uses it is started once. The
// generator ends only after stop(), and hands out what a fetch in progress has got before it ends,
// so no item is left taken by nobody. It does not throw: the loop catches nothing from it, and a
// generator that threw would end the loop with nothing logged.
export interface WorkItemSource<Item> {
    stream(worker: LoopWorker): AsyncGenerator<Item, void, undefined>;
    stop(): void;
}

// Takes one item to its outcome. signal aborts the item when it is still in flight at the deadline
// of the stop of the loop, and the processor settles it then: the stop waits until every item has
// settled. A rejected promise is an item left without an outcome, logged by the loop; a synchronous
// throw is not caught and ends the loop.
export interface WorkItemProcessor<Item> {
    process(item: Item, signal: AbortSignal): Promise<void>;
}
