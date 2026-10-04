import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { Logger } from "app/platform/logger/logger";
import type { CliCommand } from "app/telegram/cli-command/cli-command";
import type { InboxArgumentsValidator } from "app/telegram/inbox/command/inbox-arguments-validator";
import type { InboxStore } from "app/telegram/inbox/store/inbox-store";

// `make inbox-skip user=<id> chat=<id>`: the failed update that blocked the group is skipped
// (docs/architecture/inbox.md, "Unblocking a group").
@injectable()
export class InboxSkipCommand implements CliCommand {
    public constructor(
        @inject<InboxStore>(Tokens.Bot.Inbox.Store) private readonly store: InboxStore,
        @inject<InboxArgumentsValidator>(Tokens.Bot.Command.Inbox.Validator) private readonly validator: InboxArgumentsValidator,
        @inject<Logger>(Tokens.Bootstrap.Logger) private readonly logger: Logger,
    ) {}

    public async run(args: readonly string[]): Promise<void> {
        const groupKey = this.validator.validate(args);
        const updateId = await this.store.skipBlockedGroup(groupKey);

        this.logger.info("Inbox group is unblocked: its failed update is skipped.", { ...groupKey, updateId: updateId });
    }
}
