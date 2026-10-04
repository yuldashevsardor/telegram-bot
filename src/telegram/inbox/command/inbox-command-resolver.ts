import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { CliCommand } from "app/telegram/cli-command/cli-command";
import { RetrySkipCommandResolver } from "app/telegram/cli-command/retry-skip-command-resolver";

// The second level of the resolving, for the inbox: its retry and skip commands.
@injectable()
export class InboxCommandResolver extends RetrySkipCommandResolver {
    public constructor(
        @inject<CliCommand>(Tokens.Bot.Command.Inbox.Retry) retryCommand: CliCommand,
        @inject<CliCommand>(Tokens.Bot.Command.Inbox.Skip) skipCommand: CliCommand,
    ) {
        super(retryCommand, skipCommand);
    }
}
