import { promisify } from "util";
import { execFile as execFileOrigin } from "child_process";
import { ProcessFailed } from "app/shared/process/process-helper.errors";
import type { ProcessResult } from "app/shared/process/process-helper.types";

const execFile = promisify(execFileOrigin);

export class ProcessHelper {
    // execFile and not exec: the arguments go to the process as an array, past /bin/sh. Quotes,
    // $(...), ; and spaces inside them stay data, so there is nothing to escape — whereas with exec
    // every substituted value would have to be escaped.
    public static async run(file: string, args: string[] = []): Promise<ProcessResult> {
        try {
            const { stdout, stderr } = await execFile(file, args);

            return {
                stdout: stdout,
                stderr: stderr,
            };
        } catch (error) {
            throw ProcessFailed.byCommand(file, args, error);
        }
    }
}
