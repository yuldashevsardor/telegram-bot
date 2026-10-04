import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Logger } from "app/platform/logger/logger";
import type { IdArgumentsValidator } from "app/cli/validators/id-arguments-validator";
import type { CliCommand } from "app/cli/cli-command";
import type { OutboxStore } from "app/telegram/outbox/store/outbox-store";

// `make outbox-retry chat=<id>`: the failed message that blocked the chat goes back to pending
// (docs/architecture/outbox.md, "Unblocking a chat").
@injectable()
export class OutboxRetryCommand implements CliCommand {
    public constructor(
        @inject<OutboxStore>(Tokens.Bot.Outbox.Store) private readonly store: OutboxStore,
        @inject<IdArgumentsValidator>(Tokens.Cli.IdArgumentsValidator) private readonly validator: IdArgumentsValidator,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {}

    public async run(args: readonly string[]): Promise<void> {
        const { chatId } = this.validator.validate(args, ["chatId"]);
        const messageId = await this.store.retryBlockedChat(chatId);

        this.logger.info("Outbox chat is unblocked: its failed message is pending again.", { chatId: chatId, messageId: messageId });
    }
}
