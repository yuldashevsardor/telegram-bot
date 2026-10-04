import type { CliCommand } from "app/cli/cli-command";

export type ResolvedCommand = {
    command: CliCommand;
    commandArgs: string[];
};
