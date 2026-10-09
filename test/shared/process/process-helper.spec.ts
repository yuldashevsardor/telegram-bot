import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProcessHelper, STDERR_TAIL_BYTES } from "app/shared/process/process-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

// More than the default maxBuffer of execFile, 1 MiB, past which a run on fontforge's warnings failed (issue #912).
const OUTPUT_PAST_EXEC_FILE_CAP_BYTES = 2 * 1024 * 1024;
// A node with tsx started in a quarter of a second; parallel sessions slow it down past the 2 s of mocha.
const CHILD_NODE_TIMEOUT_MS = 20 * 1000;
// Long enough for the reads of stderr to catch up with what the child wrote before the pause.
const READ_PAUSE_SECONDS = 0.2;
// Low enough for the child node to take every descriptor at once.
const CHILD_DESCRIPTOR_LIMIT = 128;

// The source the child node loads, by a path that does not depend on the working directory.
const PROCESS_HELPER_SOURCE_PATH = path.resolve(__dirname, "../../../src/shared/process/process-helper.ts");

// Run by a child node with the path of process-helper.ts: takes every free descriptor but two, so that spawn fails on its pipes with
// EMFILE while a lazy file read of tsx still gets one, and prints how ProcessHelper.run ended. An
// error event without a listener would end the child with a non-zero code instead.
const RUN_WITHOUT_DESCRIPTORS = `
const fs = require("fs");
const { ProcessHelper } = require(process.argv[1]);
const openedDescriptors = [];
try {
    for (;;) openedDescriptors.push(fs.openSync("/dev/null", "r"));
} catch {}
fs.closeSync(openedDescriptors.pop());
fs.closeSync(openedDescriptors.pop());
ProcessHelper.run("/bin/true").then(
    () => console.log("resolved"),
    (error) => console.log(error.constructor.name, error.cause.code),
);
`;

describe("ProcessHelper.run", function () {
    it("passes an argument with shell metacharacters as data and not as a command", async function () {
        const argument = '$(echo injected); `echo injected`; "quoted" & rm -rf /';

        const result = await ProcessHelper.run("/bin/echo", [argument]);

        expect(result.stdout.trim()).to.equal(argument);
    });

    it("runs the process with no arguments when none were given", async function () {
        const result = await ProcessHelper.run("/bin/echo");

        expect(result.stdout).to.equal("\n");
    });

    it("does not let an argument extend the command: no side file appears", async function () {
        const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "process-helper-"));
        const marker = path.join(basePath, "injected");

        try {
            await ProcessHelper.run("/bin/echo", [`x"; touch ${marker}; echo "`]);

            expect(await fileExists(marker)).to.be.false;
        } finally {
            await fs.rm(basePath, { recursive: true, force: true });
        }
    });

    it("returns the whole stderr when it fits the tail", async function () {
        const result = await ProcessHelper.run("/bin/sh", ["-c", "printf 'Bad device table' >&2"]);

        expect(result.stderr).to.equal("Bad device table");
    });

    it("returns the whole stderr of exactly STDERR_TAIL_BYTES, even when it starts on a continuation byte", async function () {
        const script = `printf '\\200' >&2; head -c ${STDERR_TAIL_BYTES - 1} /dev/zero | tr '\\0' w >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.equal(`\uFFFD${"w".repeat(STDERR_TAIL_BYTES - 1)}`);
    });

    it("keeps only the end of stderr and succeeds when the process prints more than 1 MiB to it", async function () {
        const script = `head -c ${OUTPUT_PAST_EXEC_FILE_CAP_BYTES} /dev/zero | tr '\\0' w >&2; printf end >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.have.lengthOf(STDERR_TAIL_BYTES);
        expect(result.stderr).to.equal(`${"w".repeat(STDERR_TAIL_BYTES - "end".length)}end`);
    });

    it("does not cut a multi-byte character at the start of the stderr tail", async function () {
        // "é" is two bytes, so the tail of STDERR_TAIL_BYTES would start with its second byte.
        const script = `printf '\\303\\251' >&2; head -c ${STDERR_TAIL_BYTES - 1} /dev/zero | tr '\\0' w >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.equal("w".repeat(STDERR_TAIL_BYTES - 1));
    });

    it("moves the start of the stderr tail past three continuation bytes at most", async function () {
        // Eight continuation bytes, of no character, and the cut lands on the fifth: three are skipped,
        // the fourth stays and reads as U+FFFD.
        const script = `printf '\\200\\200\\200\\200\\200\\200\\200\\200' >&2; head -c ${STDERR_TAIL_BYTES - 4} /dev/zero | tr '\\0' w >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.equal(`\uFFFD${"w".repeat(STDERR_TAIL_BYTES - 4)}`);
    });

    it("cuts the stderr tail the same way whatever reads the output arrived in", async function () {
        // The stderr of the spec above with a pause after its first STDERR_TAIL_BYTES + 1 bytes: a read
        // ends there, and a cut on it would land inside the eight continuation bytes and skip from the
        // second one. Under a heavy load the reads may not catch up, and the spec checks no more than
        // the one above.
        const continuationByteCount = 8;
        const continuationBytes = "\\200".repeat(continuationByteCount);
        const fillerBeforePauseBytes = STDERR_TAIL_BYTES + 1 - continuationByteCount;
        const script = `printf '${continuationBytes}' >&2; head -c ${fillerBeforePauseBytes} /dev/zero | tr '\\0' w >&2; sleep ${READ_PAUSE_SECONDS}; printf www >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.equal(`\uFFFD${"w".repeat(STDERR_TAIL_BYTES - 4)}`);
    });

    it("returns the whole stdout when the process prints more than 1 MiB to it", async function () {
        const script = `head -c ${OUTPUT_PAST_EXEC_FILE_CAP_BYTES} /dev/zero | tr '\\0' o`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stdout).to.equal("o".repeat(OUTPUT_PAST_EXEC_FILE_CAP_BYTES));
    });

    it("throws ProcessFailed with the command and the exit code in payload and stderr in the message", async function () {
        try {
            await ProcessHelper.run("/bin/sh", ["-c", "printf 'Invalid spline' >&2; exit 3"]);
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).message).to.equal(
                "Command failed: /bin/sh -c printf 'Invalid spline' >&2; exit 3\nInvalid spline",
            );
            expect((error as ProcessFailed).payload).to.deep.equal({
                file: "/bin/sh",
                args: ["-c", "printf 'Invalid spline' >&2; exit 3"],
                exitCode: 3,
                signal: null,
            });
        }
    });

    it("throws ProcessFailed with the signal in payload when a signal ended the process", async function () {
        try {
            await ProcessHelper.run("/bin/sh", ["-c", "kill -KILL $$"]);
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).payload).to.deep.include({ exitCode: null, signal: "SIGKILL" });
        }
    });

    it("throws ProcessFailed even when a process that exited with an error printed nothing", async function () {
        try {
            await ProcessHelper.run("/bin/sh", ["-c", "exit 1"]);
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).message).to.equal("Command failed: /bin/sh -c exit 1\n");
        }
    });

    it("throws ProcessFailed and keeps the process alive when no descriptor is left for the pipes", async function () {
        this.timeout(CHILD_NODE_TIMEOUT_MS);
        const script = `ulimit -n ${CHILD_DESCRIPTOR_LIMIT} && exec "$0" --require tsx/cjs -e "$1" "$2"`;

        const result = await ProcessHelper.run("/bin/sh", [
            "-c",
            script,
            process.execPath,
            RUN_WITHOUT_DESCRIPTORS,
            PROCESS_HELPER_SOURCE_PATH,
        ]);

        expect(result.stdout).to.equal("ProcessFailed EMFILE\n");
    });

    it("throws ProcessFailed when spawn itself refuses an argument", async function () {
        try {
            await ProcessHelper.run("/bin/echo", ["nul\0byte"]);
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).cause).to.have.property("code", "ERR_INVALID_ARG_VALUE");
        }
    });

    it("throws ProcessFailed with the error of the start when there is no such executable", async function () {
        try {
            await ProcessHelper.run("/nonexistent/binary");
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).payload).to.deep.equal({ file: "/nonexistent/binary", args: [] });
            expect((error as ProcessFailed).cause).to.have.property("code", "ENOENT");
        }
    });

    async function fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);

            return true;
        } catch {
            return false;
        }
    }
});

describe("ProcessFailed.byCommand", function () {
    it("puts a caught non-Error value under cause in payload and takes the fallback message", function () {
        // The value is chosen so that it matches neither file nor any element of args: otherwise the
        // test would not tell what was caught from an argument of the command.
        const error = ProcessFailed.byCommand("/bin/sh", ["-c", "exit 3"], "SIGKILL");

        // The key is the same for any type, the depth is not: RuntimeError lifts only an Error into
        // the native cause, so the string stays in payload. The message is the fallback, because the
        // caught value has none.
        expect(error.message).to.equal("Process /bin/sh failed.");
        expect(error.cause).to.be.undefined;
        expect(error.payload).to.deep.equal({ file: "/bin/sh", args: ["-c", "exit 3"], cause: "SIGKILL" });
    });
});
