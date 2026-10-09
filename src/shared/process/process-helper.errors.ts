import { RuntimeError } from "app/shared/errors";
import type { ProcessExit } from "app/shared/process/process-helper.types";

export class ProcessFailed extends RuntimeError {
    public static byCommand(file: string, args: string[], error: unknown): ProcessFailed {
        return new ProcessFailed(error instanceof Error ? error.message : `Process ${file} failed.`, {
            file: file,
            args: args,
            cause: error,
        });
    }

    // The message carries stderr, the reason the process gives for its exit; payload does not repeat it.
    public static byExit(file: string, args: string[], exit: ProcessExit): ProcessFailed {
        return new ProcessFailed(`Command failed: ${[file, ...args].join(" ")}\n${exit.stderr}`, {
            file: file,
            args: args,
            exitCode: exit.exitCode,
            signal: exit.signal,
        });
    }
}
