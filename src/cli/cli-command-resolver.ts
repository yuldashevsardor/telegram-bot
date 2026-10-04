import { inject, injectable } from "inversify";
import { Tokens } from "app/shared/tokens";
import type { ResolvedCommand } from "app/cli/cli-command.types";
import type { TelegramQueueCommandResolver } from "app/cli/telegram/queue-command-resolver";
import { UnknownCommand } from "app/cli/cli-command.errors";

// The first level of the resolving: the queue picks its resolver, which picks the command by the
// action (docs/architecture/outbox.md, "Unblocking a chat").
@injectable()
export class CliCommandResolver {
    public constructor(
        @inject<TelegramQueueCommandResolver>(Tokens.Cli.Outbox.Resolver) private readonly outboxResolver: TelegramQueueCommandResolver,
        @inject<TelegramQueueCommandResolver>(Tokens.Cli.Inbox.Resolver) private readonly inboxResolver: TelegramQueueCommandResolver,
    ) {}

    // The arguments are `<queue> <action> <what the command takes>`.
    public resolve(args: readonly string[]): ResolvedCommand {
        const [queue, action, ...commandArgs] = args;

        return { command: this.queueResolver(queue, args).resolve(action, args), commandArgs: commandArgs };
    }

    private queueResolver(queue: string | undefined, args: readonly string[]): TelegramQueueCommandResolver {
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
