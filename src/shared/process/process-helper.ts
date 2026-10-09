import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { ProcessFailed } from "app/shared/process/process-helper.errors";
import type { ProcessExit, ProcessResult } from "app/shared/process/process-helper.types";

// The bits that mark a continuation byte of a multi-byte UTF-8 character: 10xxxxxx.
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const UTF8_CONTINUATION_BITS = 0b1000_0000;

// How much of the end of stderr is kept. fontforge prints a warning for every glyph it does not like, so
// the volume follows the font, not a fault (docs/architecture/font-convertor.md, "Running the engine").
// The end is where a traceback or the last error lands.
export const STDERR_TAIL_BYTES = 64 * 1024;

export class ProcessHelper {
    // spawn and not exec: the arguments go to the process as an array, past /bin/sh. Quotes,
    // $(...), ; and spaces inside them stay data, so there is nothing to escape — whereas with exec
    // every substituted value would have to be escaped. spawn and not execFile: execFile keeps the
    // whole output and rejects once it passes maxBuffer, while stderr here keeps only its end.
    public static async run(file: string, args: string[] = []): Promise<ProcessResult> {
        let exit: ProcessExit & ProcessResult;

        try {
            exit = await ProcessHelper.waitForExit(file, args);
        } catch (error) {
            throw ProcessFailed.byCommand(file, args, error);
        }

        if (exit.exitCode !== 0) {
            throw ProcessFailed.byExit(file, args, exit);
        }

        return {
            stdout: exit.stdout,
            stderr: exit.stderr,
        };
    }

    // Rejects when the process did not start. spawn throws on an invalid argument, and on EMFILE it
    // returns a child without streams and emits error on the next tick, where an error without a
    // listener would end the whole bot: hence the listener comes first and the streams are checked.
    private static waitForExit(file: string, args: string[]): Promise<ProcessExit & ProcessResult> {
        return new Promise((resolve, reject) => {
            const child: ChildProcess = spawn(file, args);
            const stdoutChunks: Array<Buffer> = [];
            let stderrTail: Buffer = Buffer.alloc(0);

            child.on("error", reject);
            child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
            child.stderr?.on("data", (chunk: Buffer) => {
                stderrTail = ProcessHelper.keepTail(Buffer.concat([stderrTail, chunk]));
            });
            child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
                resolve({
                    exitCode: exitCode,
                    signal: signal,
                    stdout: Buffer.concat(stdoutChunks).toString(),
                    stderr: stderrTail.toString(),
                });
            });
        });
    }

    private static keepTail(stderrSoFar: Buffer): Buffer {
        // Stryker disable next-line EqualityOperator: `<` is equivalent: at exactly STDERR_TAIL_BYTES the cut starts at byte 0 and keeps the whole output, as stderr does not start inside a character
        if (stderrSoFar.length <= STDERR_TAIL_BYTES) {
            return stderrSoFar;
        }

        let tailStart = stderrSoFar.length - STDERR_TAIL_BYTES;

        // A cut inside a multi-byte character would start the tail with U+FFFD: the start moves past the
        // rest of that character.
        while (ProcessHelper.isUtf8Continuation(stderrSoFar[tailStart])) {
            tailStart++;
        }

        return stderrSoFar.subarray(tailStart);
    }

    private static isUtf8Continuation(byte: number | undefined): boolean {
        return byte !== undefined && (byte & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS;
    }
}
