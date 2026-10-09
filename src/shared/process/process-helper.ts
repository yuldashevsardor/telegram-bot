import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { ProcessFailed } from "app/shared/process/process-helper.errors";
import type { ProcessExit, ProcessResult } from "app/shared/process/process-helper.types";

// The bits that mark a continuation byte of a multi-byte UTF-8 character: 10xxxxxx.
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const UTF8_CONTINUATION_BITS = 0b1000_0000;
// A UTF-8 character is at most four bytes, a lead byte and three continuation bytes.
const UTF8_MAX_CONTINUATION_BYTES = 3;

// How much of the end of stderr is kept. fontforge prints a warning for every glyph it does not like, so
// the volume follows the font, not a fault (docs/architecture/font-convertor.md, "Running the engine").
// The end is where a traceback or the last error lands.
export const STDERR_TAIL_BYTES = 64 * 1024;

export class ProcessHelper {
    // What is kept of stderr while it is read: its last STDERR_TAIL_BYTES and one byte more, by which
    // keepTail tells on close whether the output was cut. The tail is aligned to a character once, on
    // close: aligned on every chunk, it would skip from wherever a read happened to end.
    private static readonly STDERR_WINDOW_BYTES = STDERR_TAIL_BYTES + 1;

    // spawn and not exec: the arguments go to the process as an array, past /bin/sh. Quotes,
    // $(...), ; and spaces inside them stay data, so there is nothing to escape — whereas with exec
    // every substituted value would have to be escaped. spawn and not execFile: execFile keeps the
    // whole output and rejects once it passes maxBuffer, while stderr here keeps only its end.
    public static async run(file: string, args: string[] = []): Promise<ProcessResult> {
        let exit: ProcessExit;

        try {
            exit = await ProcessHelper.waitForExit(file, args);
        } catch (error) {
            throw ProcessFailed.byCommand(file, args, error);
        }

        if (exit.exitCode !== 0) {
            throw ProcessFailed.byExit(file, args, exit);
        }

        return exit;
    }

    // Rejects when the process did not start. spawn throws on an invalid argument, and on EMFILE it
    // returns a child without streams and emits error on the next tick, where an error without a
    // listener would end the whole bot: hence the listener comes first and the streams are checked.
    private static waitForExit(file: string, args: string[]): Promise<ProcessExit> {
        return new Promise((resolve, reject) => {
            const child: ChildProcess = spawn(file, args);
            const stdoutChunks: Array<Buffer> = [];
            let stderrWindow: Buffer = Buffer.alloc(0);

            child.on("error", reject);
            child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
            child.stderr?.on("data", (chunk: Buffer) => {
                stderrWindow = Buffer.concat([stderrWindow, chunk]).subarray(-ProcessHelper.STDERR_WINDOW_BYTES);
            });
            child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
                resolve({
                    exitCode: exitCode,
                    signal: signal,
                    stdout: Buffer.concat(stdoutChunks).toString(),
                    stderr: ProcessHelper.keepTail(stderrWindow).toString(),
                });
            });
        });
    }

    private static keepTail(stderrWindow: Buffer): Buffer {
        // Stryker disable next-line EqualityOperator: `<` differs only on output of exactly STDERR_TAIL_BYTES that starts on a continuation byte, which UTF-8 output never does; there the tail still starts within three bytes of the cut, the bound required of it
        if (stderrWindow.length <= STDERR_TAIL_BYTES) {
            return stderrWindow;
        }

        const cutStart = stderrWindow.length - STDERR_TAIL_BYTES;
        let tailStart = cutStart;

        // A cut inside a multi-byte character would start the tail with U+FFFD: the start moves past the
        // rest of that character. Output that is not UTF-8 could run on with continuation bytes and
        // empty the tail, so no further than one character goes.
        while (tailStart - cutStart < UTF8_MAX_CONTINUATION_BYTES && ProcessHelper.isUtf8Continuation(stderrWindow.readUInt8(tailStart))) {
            tailStart++;
        }

        return stderrWindow.subarray(tailStart);
    }

    private static isUtf8Continuation(byte: number): boolean {
        return (byte & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS;
    }
}
