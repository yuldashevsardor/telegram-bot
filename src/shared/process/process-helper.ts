import { promisify } from "util";
import { execFile as execFileOrigin } from "child_process";
import { ProcessFailed } from "app/shared/process/process-helper.errors";
import type { ProcessResult } from "app/shared/process/process-helper.types";

const execFile = promisify(execFileOrigin);

export class ProcessHelper {
    // execFile, а не exec: аргументы уходят процессу массивом, минуя /bin/sh. Кавычки,
    // $(...), ; и пробелы в них остаются данными, поэтому экранировать нечего — а с exec
    // экранировать пришлось бы каждое подставленное значение.
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
