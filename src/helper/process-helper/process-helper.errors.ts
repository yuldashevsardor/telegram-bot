import { RuntimeError } from "app/common/errors";

export class ProcessFailed extends RuntimeError {
    public static byCommand(file: string, args: string[], error: unknown): ProcessFailed {
        if (!(error instanceof Error)) {
            return new ProcessFailed(`Process ${file} failed.`, {
                file: file,
                args: args,
                error: error,
            });
        }

        return new ProcessFailed(error.message, {
            file: file,
            args: args,
            cause: error,
        });
    }
}
