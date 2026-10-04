import { Command } from "app/telegram/command/command";
import { inject, injectable } from "inversify";
import { StringHelper } from "app/shared/string/string-helper";
import { Tokens } from "app/shared/tokens";
import type { Context } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { OutboxMessageInput } from "app/telegram/outbox/store/outbox-store.types";
import { OutboxPriority } from "app/telegram/outbox/store/outbox-store.types";
import { serialize } from "app/telegram/outbox/payload-codec/payload-codec";

const CHAT_IDS = [2815426, 5067823410, 858262157];
const MESSAGE_COUNT = 10_000;
// One batch is one transaction with the messages as one jsonb parameter, so the load is split.
const BATCH_SIZE = 1_000;
const TEXT_LENGTH_CHARS = 1000;
const METHOD = "sendMessage";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly descriptionKey: string = "bulk-messages-command-description";

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {
        super();
    }

    // Pushes the messages straight into the outbox, below the calls of the bot API, and waits for
    // none of them to be sent.
    protected async handle(_ctx: Context): Promise<void> {
        for (let firstIndex = 0; firstIndex < MESSAGE_COUNT; firstIndex += BATCH_SIZE) {
            await this.store.pushBatch(this.buildBatch(firstIndex));
        }

        this.logger.info("Bulk messages are pushed to the outbox.", { messageCount: MESSAGE_COUNT });
    }

    // The chats take the messages in turn.
    private buildBatch(firstIndex: number): OutboxMessageInput[] {
        const batch: OutboxMessageInput[] = [];

        for (let index = firstIndex; index < firstIndex + BATCH_SIZE; index++) {
            const chatId = CHAT_IDS[index % CHAT_IDS.length] as number;
            const payload = { chat_id: chatId, text: StringHelper.generateRandomString(TEXT_LENGTH_CHARS) };

            batch.push({ chatId: chatId, method: METHOD, payload: serialize(METHOD, payload), priority: OutboxPriority.Bulk });
        }

        return batch;
    }
}
