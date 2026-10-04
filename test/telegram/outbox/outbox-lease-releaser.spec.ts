import { expect } from "chai";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxLeaseReleaser } from "app/telegram/outbox/lease/outbox-lease-releaser";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, OutboxLease, OutboxRetryOptions } from "app/telegram/outbox/store/outbox-store.types";

// What the attempt of a release on stop ends with. Spelled out rather than imported: the releaser
// keeps it private, and the attempts it lands in are read by people.
const NODE_STOPPED: OutboxAttemptError = {
    name: "OutboxNodeStopped",
    message: "The node stopped before the call of the message finished: the message is released to any node.",
    kind: TelegramBotApiFailureKind.Transient,
};

type RetryCall = { lease: OutboxLease; error: OutboxAttemptError; delayMs: number; options?: OutboxRetryOptions };

// Records what the releaser asks of the store: how it is written is pinned by the store spec.
class RecordingStore {
    public readonly calls: RetryCall[] = [];

    public async retry(lease: OutboxLease, error: OutboxAttemptError, delayMs: number, options?: OutboxRetryOptions): Promise<void> {
        this.calls.push(options === undefined ? { lease, error, delayMs } : { lease, error, delayMs, options });
    }
}

describe("OutboxLeaseReleaser", function () {
    it("returns the message to pending with no delay and an attempt of the stopped node, then wakes the idle nodes", async function () {
        const store = new RecordingStore();
        const lease = leaseAfter(0);

        await new OutboxLeaseReleaser(store as unknown as OutboxStore).releaseOnStop(lease);

        expect(store.calls).to.deep.equal([{ lease, error: NODE_STOPPED, delayMs: 0, options: { shouldWakeIdleNodes: true } }]);
    });

    it("retries the message even on its hundredth attempt: a stop blocks no chat", async function () {
        const store = new RecordingStore();
        const lease = leaseAfter(100);

        await new OutboxLeaseReleaser(store as unknown as OutboxStore).releaseOnStop(lease);

        expect(store.calls).to.have.lengthOf(1);
    });
});

function leaseAfter(earlierAttempts: number): OutboxLease & { earlierAttempts: number } {
    return {
        id: 7,
        lockToken: "5b0c2f4e-8a4f-4d0e-9f1a-2d6c3b7e9a10",
        startedAt: "2026-09-29T10:01:00.000000+00:00",
        worker: { host: "node-1", pid: 101, workerId: "worker-1" },
        earlierAttempts,
    };
}
