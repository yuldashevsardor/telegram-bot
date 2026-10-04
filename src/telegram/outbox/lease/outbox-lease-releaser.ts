import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import { TelegramBotApiFailureKind } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier.types";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxAttemptError, OutboxLease } from "app/telegram/outbox/store/outbox-store.types";

// The error of the attempt a release on stop closes: the call may have reached Telegram or not.
const NODE_STOPPED: OutboxAttemptError = {
    name: "OutboxNodeStopped",
    message: "The node stopped before the call of the message finished: the message is released to any node.",
    kind: TelegramBotApiFailureKind.Transient,
};

// A released message waits for no retry delay: the stop says nothing about the message.
const RELEASE_DELAY_MS = 0;

// Hands a lease of the stopping node back (docs/architecture/outbox.md, "Release on stop").
@injectable()
export class OutboxLeaseReleaser {
    public constructor(@inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore) {}

    // A message whose call the stopping node did not finish goes back to pending, and its chat is
    // ready for the next pull on any node. The attempt counts as a transient failure's, although the
    // limit of attempts is not checked: the stop says nothing about the message, so it blocks no chat.
    // The call must have settled before: a call still on its way could reach Telegram after the
    // next message of the chat.
    public async releaseOnStop(lease: OutboxLease): Promise<void> {
        await this.store.retry(lease, NODE_STOPPED, RELEASE_DELAY_MS);
    }
}
