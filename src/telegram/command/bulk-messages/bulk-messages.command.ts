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
const BATCH_MESSAGE_COUNT = 1_000;
const TEXT_LENGTH_CHARS = 1000;
const BULK_METHOD = "sendMessage";

@injectable()
export class BulkMessagesCommand extends Command {
    public readonly command: string = "bulk_messages";
    public readonly descriptionKey: string = "bulk-messages-command-description";
    // The chats the menu shows the command in (Bot.setupCommands()).
    public readonly chatIds: readonly number[] = CHAT_IDS;

    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {
        super();
    }

    // Straight into the outbox, so that the chats yield to the chats with calls of the bot, and
    // waiting for none of the messages (docs/architecture/bot.md, "Commands").
    protected async handle(ctx: Context): Promise<void> {
        // The menu hides the command from other chats, but a typed command still comes, and only the
        // owner's accounts are meant to load the outbox with it.
        const senderChatId = ctx.chat?.id;

        if (senderChatId === undefined || !CHAT_IDS.includes(senderChatId)) {
            return;
        }

        for (let firstIndex = 0; firstIndex < MESSAGE_COUNT; firstIndex += BATCH_MESSAGE_COUNT) {
            await this.store.pushBatch(this.buildBatch(firstIndex));
        }

        this.logger.info("Bulk messages are pushed to the outbox.", { messageCount: MESSAGE_COUNT });
    }

    private buildBatch(firstIndex: number): OutboxMessageInput[] {
        const batch: OutboxMessageInput[] = [];

        for (let index = firstIndex; index < firstIndex + BATCH_MESSAGE_COUNT; index++) {
            const chatId = CHAT_IDS[index % CHAT_IDS.length] as number;
            const payload = { chat_id: chatId, text: StringHelper.generateRandomString(TEXT_LENGTH_CHARS) };

            batch.push({ chatId: chatId, method: BULK_METHOD, payload: serialize(BULK_METHOD, payload), priority: OutboxPriority.Bulk });
        }

        return batch;
    }
}
