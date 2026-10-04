import { expect } from "chai";
import type { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxLeaseRecovery } from "app/telegram/outbox/outbox-lease-recovery";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { ExpiredOutboxLease } from "app/telegram/outbox/store/outbox-store.types";

class FakeStore {
    public expiredLeases: ExpiredOutboxLease[] = [];

    public async findExpiredLeases(): Promise<ExpiredOutboxLease[]> {
        return this.expiredLeases;
    }
}

class FakeFailureHandler {
    public readonly handled: ExpiredOutboxLease[] = [];
    // The lease whose completion throws.
    public failingLease: ExpiredOutboxLease | undefined = undefined;

    public async handleExpiredLease(expiredLease: ExpiredOutboxLease): Promise<void> {
        if (expiredLease === this.failingLease) {
            throw new Error("connection lost");
        }

        this.handled.push(expiredLease);
    }
}

describe("OutboxLeaseRecovery", function () {
    let store: FakeStore;
    let failureHandler: FakeFailureHandler;
    let recovery: OutboxLeaseRecovery;

    beforeEach(function () {
        store = new FakeStore();
        failureHandler = new FakeFailureHandler();
        recovery = new OutboxLeaseRecovery(store as unknown as OutboxStore, failureHandler as unknown as OutboxFailureHandler);
    });

    it("hands every expired lease to the failure handler, one after another", async function () {
        const first = expiredLease(7);
        const second = expiredLease(8);
        store.expiredLeases = [first, second];

        await recovery.recover();

        expect(failureHandler.handled).to.deep.equal([first, second]);
    });

    it("hands nothing when no lease has expired", async function () {
        await recovery.recover();

        expect(failureHandler.handled).to.deep.equal([]);
    });

    it("leaves the leases after a failed completion to the next call", async function () {
        const failing = expiredLease(7);
        store.expiredLeases = [failing, expiredLease(8)];
        failureHandler.failingLease = failing;

        let thrown: unknown;
        try {
            await recovery.recover();
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect(failureHandler.handled).to.deep.equal([]);
    });
});

function expiredLease(id: number): ExpiredOutboxLease {
    return {
        id,
        lockToken: "9e4d1c7a-3b2f-4a6e-8c5d-1f0b2a3c4d5e",
        startedAt: "2026-09-29T10:02:00.000000+00:00",
        worker: null,
        earlierAttempts: 0,
    };
}
