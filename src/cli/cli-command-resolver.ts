import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { QueueCommandResolver, ResolvedCommand } from "app/cli/cli-command.types";
import { UnknownCommand } from "app/cli/cli-command.errors";

// The first level of the resolving: the queue picks its resolver, which picks the command by the
// action (docs/architecture/outbox.md, "Unblocking a chat").
@injectable()
export class CliCommandResolver {
    public constructor(
        @inject<QueueCommandResolver>(Tokens.Cli.Outbox.Resolver) private readonly outboxResolver: QueueCommandResolver,
        @inject<QueueCommandResolver>(Tokens.Cli.Inbox.Resolver) private readonly inboxResolver: QueueCommandResolver,
    ) {}

    // The arguments are `<queue> <action> <what the command takes>`.
    public resolve(args: readonly string[]): ResolvedCommand {
        const [queue, action, ...commandArgs] = args;

        return { command: this.queueResolver(queue, args).resolve(action, args), commandArgs: commandArgs };
    }

    private queueResolver(queue: string | undefined, args: readonly string[]): QueueCommandResolver {
        switch (queue) {
            case "outbox":
                return this.outboxResolver;
            case "inbox":
                return this.inboxResolver;
            default:
                throw UnknownCommand.of(args);
        }
    }
}
