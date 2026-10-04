import type { WorkerIdentity } from "app/telegram/worker-loop/worker-loop.types";

// The items of a WorkerLoop. A source serves one generator, so the loop that uses it is started once.
// The generator ends only after stop(), and hands out what a fetch in progress has got before it
// ends, so no item is left taken by nobody. It does not throw: the loop does not catch it, and the
// rejection of the loop is unhandled, which app.ts logs at critical and ends the process with.
export interface WorkItemSource<Item> {
    stream(worker: WorkerIdentity): AsyncGenerator<Item, void, undefined>;
    stop(): void;
}
