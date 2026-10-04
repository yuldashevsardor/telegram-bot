import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Logger } from "app/platform/logger/logger";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";
import type { InboxGroupKey } from "app/telegram/inbox/store/inbox-store.types";
import { InvalidUnblockArguments } from "app/telegram/unblock-command-line/unblock-command-line.errors";

// What `make outbox-retry`, `outbox-skip`, `inbox-retry` and `inbox-skip` run, through src/unblock.ts:
// the arguments after the program name, `<outbox|inbox> <retry|skip> <ids>`
// (docs/architecture/outbox.md, "Unblocking a chat").
@injectable()
export class UnblockCommandLine {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly outboxStore: OutboxStore,
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly inboxStore: InboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {}

    // Arguments the command does not know throw InvalidUnblockArguments before the database is read.
    public async run(args: readonly string[]): Promise<void> {
        switch (`${args[0]} ${args[1]}`) {
            case "outbox retry": {
                const chatId = this.parseChatId(args);
                const messageId = await this.outboxStore.retryBlockedChat(chatId);

                this.logger.info("Outbox chat is unblocked: its failed message is pending again.", {
                    chatId: chatId,
                    messageId: messageId,
                });

                return;
            }
            case "outbox skip": {
                const chatId = this.parseChatId(args);
                const messageId = await this.outboxStore.skipBlockedChat(chatId);

                this.logger.info("Outbox chat is unblocked: its failed message is skipped.", { chatId: chatId, messageId: messageId });

                return;
            }
            case "inbox retry": {
                const groupKey = this.parseGroupKey(args);
                const updateId = await this.inboxStore.retryBlockedGroup(groupKey);

                this.logger.info("Inbox group is unblocked: its failed update is pending again.", { ...groupKey, updateId: updateId });

                return;
            }
            case "inbox skip": {
                const groupKey = this.parseGroupKey(args);
                const updateId = await this.inboxStore.skipBlockedGroup(groupKey);

                this.logger.info("Inbox group is unblocked: its failed update is skipped.", { ...groupKey, updateId: updateId });

                return;
            }
            default:
                throw InvalidUnblockArguments.of(args);
        }
    }

    private parseChatId(args: readonly string[]): number {
        if (args.length !== 3) {
            throw InvalidUnblockArguments.of(args);
        }

        return this.parseId(args[2], args);
    }

    private parseGroupKey(args: readonly string[]): InboxGroupKey {
        if (args.length !== 4) {
            throw InvalidUnblockArguments.of(args);
        }

        return { userId: this.parseId(args[2], args), chatId: this.parseId(args[3], args) };
    }

    // A Telegram id: a whole number, negative for a group chat. Number() alone would take "" for 0.
    private parseId(idArgument: string | undefined, args: readonly string[]): number {
        if (idArgument === undefined || !/^-?\d+$/.test(idArgument) || !Number.isSafeInteger(Number(idArgument))) {
            throw InvalidUnblockArguments.of(args);
        }

        return Number(idArgument);
    }
}
