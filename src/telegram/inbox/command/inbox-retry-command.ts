import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Logger } from "app/platform/logger/logger";
import { ArgumentRule, ArgumentsHelper } from "app/cli/arguments-helper";
import type { CliCommand } from "app/cli/cli-command";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";

// `make inbox-retry user=<id> chat=<id>`: the failed update that blocked the group goes back to
// pending (docs/architecture/inbox.md, "Unblocking a group").
@injectable()
export class InboxRetryCommand implements CliCommand {
    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {}

    public async run(args: readonly string[]): Promise<void> {
        const groupKey = ArgumentsHelper.parse(args, { userId: ArgumentRule.Integer, chatId: ArgumentRule.Integer });
        const updateId = await this.store.retryBlockedGroup(groupKey);

        this.logger.info("Inbox group is unblocked: its failed update is pending again.", { ...groupKey, updateId: updateId });
    }
}
