import { spawn } from "child_process";
import { once } from "events";
import { ProcessFailed } from "app/shared/process/process-helper.errors";
import type { ProcessResult } from "app/shared/process/process-helper.types";

// How much of the end of stderr is kept. fontforge prints a warning per glyph it does not like, and on a
// variable font that came to 2.4 MB (issue https://github.com/yuldashevsardor/telegram-bot/issues/912):
// the volume follows the font, not a fault. The end is where a traceback or the last error lands.
export const STDERR_TAIL_BYTES = 64 * 1024;

export class ProcessHelper {
    // spawn and not exec: the arguments go to the process as an array, past /bin/sh. Quotes,
    // $(...), ; and spaces inside them stay data, so there is nothing to escape — whereas with exec
    // every substituted value would have to be escaped. spawn and not execFile: execFile keeps the
    // whole output and rejects once it passes maxBuffer, while stderr here keeps only its end.
    public static async run(file: string, args: string[] = []): Promise<ProcessResult> {
        const child = spawn(file, args);
        const stdoutChunks: Array<Buffer> = [];
        let stderrTail: Buffer = Buffer.alloc(0);

        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            stderrTail = ProcessHelper.keepTail(Buffer.concat([stderrTail, chunk]));
        });

        let exitCode: number | null;
        let signal: NodeJS.Signals | null;

        try {
            // once rejects on an error event: the process did not start, and a close does not always follow.
            [exitCode, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
        } catch (error) {
            throw ProcessFailed.byCommand(file, args, error);
        }

        const stderr = stderrTail.toString();

        if (exitCode !== 0) {
            throw ProcessFailed.byExit(file, args, { exitCode: exitCode, signal: signal, stderr: stderr });
        }

        return {
            stdout: Buffer.concat(stdoutChunks).toString(),
            stderr: stderr,
        };
    }

    private static keepTail(output: Buffer): Buffer {
        // Stryker disable next-line EqualityOperator: `>=` is equivalent: at exactly STDERR_TAIL_BYTES the tail is the whole output
        if (output.length > STDERR_TAIL_BYTES) {
            return output.subarray(output.length - STDERR_TAIL_BYTES);
        }

        return output;
    }
}
