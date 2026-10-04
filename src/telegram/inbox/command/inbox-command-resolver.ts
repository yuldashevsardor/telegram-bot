import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { CliCommand } from "app/cli/cli-command";
import { RetrySkipCommandResolver } from "app/cli/retry-skip-command-resolver";

// The second level of the resolving, for the inbox: its retry and skip commands.
@injectable()
export class InboxCommandResolver extends RetrySkipCommandResolver {
    public constructor(
        @inject<CliCommand>(Tokens.Cli.Inbox.Retry) retryCommand: CliCommand,
        @inject<CliCommand>(Tokens.Cli.Inbox.Skip) skipCommand: CliCommand,
    ) {
        super(retryCommand, skipCommand);
    }
}
