import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { InboxFailureKind } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier.types";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxAttemptError, InboxLease } from "app/telegram/inbox/store/inbox-store.types";

// The error of the attempt a release on stop closes: the handler may have replied or not.
const NODE_STOPPED: InboxAttemptError = {
    name: "InboxNodeStopped",
    message: "The node stopped before the handler of the update finished: the update is released to any node.",
    kind: InboxFailureKind.Transient,
};

// A released update waits for no retry delay: the stop says nothing about the update.
const RELEASE_DELAY_MS = 0;

// Hands a lease of the stopping node back (docs/architecture/inbox.md, "Release on stop").
@injectable()
export class InboxLeaseReleaser {
    public constructor(@inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore) {}

    // The handler must have settled before: one still running could reply after the next update of
    // the group is handled (docs/architecture/inbox.md, "Release on stop").
    public async releaseOnStop(lease: InboxLease): Promise<void> {
        await this.store.retry(lease, NODE_STOPPED, RELEASE_DELAY_MS);
    }
}
