import type { CliCommand } from "app/cli/cli-command";
import type { QueueCommandResolver } from "app/cli/cli-command.types";
import { UnknownCommand } from "app/cli/cli-command.errors";

// The second level of the resolving: the command of a queue by its action, `retry` or `skip`. A
// queue extends it only to say which commands are its own, by their tokens.
export abstract class RetrySkipCommandResolver implements QueueCommandResolver {
    protected constructor(private readonly retryCommand: CliCommand, private readonly skipCommand: CliCommand) {}

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
