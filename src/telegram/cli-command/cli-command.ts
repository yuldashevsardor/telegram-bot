// A command of `npm run cli`: the arguments that are left once the queue and the action are
// taken off. The command checks them itself, since another command may take other ones.
export interface CliCommand {
    run(args: readonly string[]): Promise<void>;
}

// Picks the command of one queue, `outbox` or `inbox`, by its action. The whole of the arguments
// comes along for the error.
export interface QueueCommandResolver {
    resolve(action: string | undefined, args: readonly string[]): CliCommand;
}

export type ResolvedCommand = {
    command: CliCommand;
    commandArgs: string[];
};
