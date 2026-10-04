import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { CliCommand } from "app/cli/cli-command";
import { TelegramQueueCommandResolver } from "app/cli/telegram/queue-command-resolver";

// The second level of the resolving, for the outbox: its retry and skip commands.
@injectable()
export class OutboxCommandResolver extends TelegramQueueCommandResolver {
    public constructor(
        @inject<CliCommand>(Tokens.Cli.Outbox.Retry) retryCommand: CliCommand,
        @inject<CliCommand>(Tokens.Cli.Outbox.Skip) skipCommand: CliCommand,
    ) {
        super(retryCommand, skipCommand);
    }
}
