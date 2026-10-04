import type { WorkerIdentity } from "app/telegram/worker-loop/worker-loop.types";

// The items of a WorkerLoop. A source serves one generator, so the loop that uses it is started once.
// The generator ends only after stop(), and hands out what a fetch in progress has got before it
// ends. A fetch takes one item, and the generator holds nothing taken between yields: at the stop
// the loop starts the item it has got and closes the generator, so an item still held would stay
// taken by this node. The generator does not throw: the loop does not catch it (WorkerLoop).
export interface WorkItemSource<Item> {
    stream(worker: WorkerIdentity): AsyncGenerator<Item, void, undefined>;
    stop(): void;
}
