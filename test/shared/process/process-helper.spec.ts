import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProcessHelper, STDERR_TAIL_BYTES } from "app/shared/process/process-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

// More than the default maxBuffer of execFile, 1 MiB, past which a run on fontforge's warnings failed (issue #912).
const OUTPUT_PAST_EXEC_FILE_CAP_BYTES = 2 * 1024 * 1024;

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

    it("keeps only the end of stderr and succeeds when the process prints more than 1 MiB to it", async function () {
        const script = `head -c ${OUTPUT_PAST_EXEC_FILE_CAP_BYTES} /dev/zero | tr '\\0' w >&2; printf end >&2`;

        const result = await ProcessHelper.run("/bin/sh", ["-c", script]);

        expect(result.stderr).to.have.lengthOf(STDERR_TAIL_BYTES);
        expect(result.stderr).to.equal(`${"w".repeat(STDERR_TAIL_BYTES - "end".length)}end`);
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
