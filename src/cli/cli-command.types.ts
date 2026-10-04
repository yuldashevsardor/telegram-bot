import type { CliCommand } from "app/cli/cli-command";

// Picks the command of one queue, `outbox` or `inbox`, by its action. The whole of the arguments
// comes along for the error.
export interface QueueCommandResolver {
    resolve(action: string | undefined, args: readonly string[]): CliCommand;
}

export type ResolvedCommand = {
    command: CliCommand;
    commandArgs: string[];
};
