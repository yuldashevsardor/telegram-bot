// Takes one item of a WorkerLoop to its outcome. signal aborts the item when it is still in flight
// at the deadline of the stop of the loop, and the processor settles it then: the stop waits until
// every item has settled. The signal may come aborted already, for an item a fetch in progress
// handed out after the deadline: the processor checks signal.aborted, or hands the signal to a call
// that checks it, as grammY does; an abort listener alone would let it do the whole item. A rejected
// promise is an item left without an outcome, which the loop logs. process() does not throw
// synchronously: the loop does not catch it (WorkerLoop).
export interface WorkItemProcessor<Item> {
    process(item: Item, signal: AbortSignal): Promise<void>;
}
