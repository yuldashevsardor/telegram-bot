import { expect } from "chai";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import { OutboxLeaseRecovery } from "app/telegram/outbox/outbox-lease-recovery";
import { OutboxRetrier } from "app/telegram/outbox/outbox-retrier";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { ExpiredOutboxLease, OutboxAttemptError, OutboxLease } from "app/telegram/outbox/store/outbox-store.types";

const MAX_ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;
const MULTIPLIER = 2;
// random() of 0 takes the lower end of the step: half of it.
const RETRY_DELAY = new OutboxRetryDelay({ firstDelayMs: FIRST_DELAY_MS, maxDelayMs: 60_000, multiplier: MULTIPLIER }, () => 0);

// What the attempt of an expired lease ends with. Spelled out rather than imported: the recovery
// keeps it private, and the attempts it lands in are read by people.
const LEASE_EXPIRED: OutboxAttemptError = {
    name: "OutboxLeaseExpired",
    message: "The lease of the chat passed before its message was completed: the node that pulled it is presumed dead.",
    kind: TelegramBotApiFailureKind.Transient,
};

type StoreCall =
    | { method: "retry"; lease: OutboxLease; error: OutboxAttemptError; delayMs: number }
    | { method: "markAsFailedAndBlockChat"; lease: OutboxLease; error: OutboxAttemptError };

// Records what the recovery asks of the store: how it is written is pinned by the store spec.
class RecordingStore {
    public readonly calls: StoreCall[] = [];
    public expiredLeases: ExpiredOutboxLease[] = [];
    // The lease whose completion throws.
    public failingLease: ExpiredOutboxLease | undefined = undefined;

    public async findExpiredLeases(): Promise<ExpiredOutboxLease[]> {
        return this.expiredLeases;
    }

    public async retry(lease: OutboxLease, error: OutboxAttemptError, delayMs: number): Promise<void> {
        this.throwIfFailing(lease);
        this.calls.push({ method: "retry", lease, error, delayMs });
    }

    public async markAsFailedAndBlockChat(lease: OutboxLease, error: OutboxAttemptError): Promise<void> {
        this.throwIfFailing(lease);
        this.calls.push({ method: "markAsFailedAndBlockChat", lease, error });
    }

    private throwIfFailing(lease: OutboxLease): void {
        if (lease === this.failingLease) {
            throw new Error("connection lost");
        }
    }
}

describe("OutboxLeaseRecovery", function () {
    let store: RecordingStore;
    let recovery: OutboxLeaseRecovery;

    beforeEach(function () {
        store = new RecordingStore();
        recovery = new OutboxLeaseRecovery(
            store as unknown as OutboxStore,
            new OutboxRetrier(store as unknown as OutboxStore, RETRY_DELAY, MAX_ATTEMPTS),
        );
    });

    it("retries the message of every expired lease as a transient failure after the delay of its attempt", async function () {
        const first = expiredAfter(7, 0);
        const second = expiredAfter(8, 1);
        store.expiredLeases = [first, second];

        await recovery.recover();

        // The first attempt waits half of the first step, the second half of the doubled one.
        expect(store.calls).to.deep.equal([
            { method: "retry", lease: first, error: LEASE_EXPIRED, delayMs: FIRST_DELAY_MS / 2 },
            { method: "retry", lease: second, error: LEASE_EXPIRED, delayMs: (FIRST_DELAY_MS * MULTIPLIER) / 2 },
        ]);
    });

    it("fails the message of an expired lease on its last attempt and blocks its chat", async function () {
        const expired = expiredAfter(7, MAX_ATTEMPTS - 1);
        store.expiredLeases = [expired];

        await recovery.recover();

        expect(store.calls).to.deep.equal([{ method: "markAsFailedAndBlockChat", lease: expired, error: LEASE_EXPIRED }]);
    });

    it("changes nothing when no lease has expired", async function () {
        await recovery.recover();

        expect(store.calls).to.deep.equal([]);
    });

    it("leaves the leases after a failed completion to the next call", async function () {
        const failing = expiredAfter(7, 0);
        store.expiredLeases = [failing, expiredAfter(8, 0)];
        store.failingLease = failing;

        let thrown: unknown;
        try {
            await recovery.recover();
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect(store.calls).to.deep.equal([]);
    });
});

// A lease that passed before its message was completed, after earlierAttempts attempts.
function expiredAfter(id: number, earlierAttempts: number): ExpiredOutboxLease {
    return {
        id,
        lockToken: "9e4d1c7a-3b2f-4a6e-8c5d-1f0b2a3c4d5e",
        startedAt: "2026-09-29T10:02:00.000000+00:00",
        worker: null,
        earlierAttempts,
    };
}
