import { RuntimeError } from "app/shared/errors";

export class ProcessFailed extends RuntimeError {
    public static byCommand(file: string, args: string[], error: unknown): ProcessFailed {
        return new ProcessFailed(error instanceof Error ? error.message : `Process ${file} failed.`, {
            file: file,
            args: args,
            cause: error,
        });
    }
}
