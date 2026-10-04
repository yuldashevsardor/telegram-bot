import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { CliCommand, QueueCommandResolver } from "app/telegram/cli-command/cli-command";
import { UnknownCommand } from "app/telegram/cli-command/cli-command.errors";

// The second level of the resolving, for the outbox: the command by its action.
@injectable()
export class OutboxCommandResolver implements QueueCommandResolver {
    public constructor(
        @inject<CliCommand>(Tokens.Bot.Command.Outbox.Retry) private readonly retryCommand: CliCommand,
        @inject<CliCommand>(Tokens.Bot.Command.Outbox.Skip) private readonly skipCommand: CliCommand,
    ) {}

    public resolve(action: string | undefined, args: readonly string[]): CliCommand {
        switch (action) {
            case "retry":
                return this.retryCommand;
            case "skip":
                return this.skipCommand;
            default:
                throw UnknownCommand.of(args);
        }
    }
}
