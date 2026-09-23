import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProcessHelper } from "app/shared/process/process-helper";
import { ProcessFailed } from "app/shared/process/process-helper.errors";

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

    it("throws ProcessFailed with the command in payload when the process exited with an error", async function () {
        try {
            await ProcessHelper.run("/bin/sh", ["-c", "exit 3"]);
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
            expect((error as ProcessFailed).payload).to.deep.include({
                file: "/bin/sh",
                args: ["-c", "exit 3"],
            });
            expect((error as ProcessFailed).cause).to.be.instanceOf(Error);
        }
    });

    it("throws ProcessFailed when there is no such executable", async function () {
        try {
            await ProcessHelper.run("/nonexistent/binary");
            expect.fail("a ProcessFailed error was expected");
        } catch (error) {
            expect(error).to.be.instanceOf(ProcessFailed);
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

        // The key does not depend on the type, the depth does: RuntimeError raises only an Error into
        // the native cause, so the string stays in payload — and the message taken is the fallback,
        // there being nothing to take it from in the caught value.
        expect(error.message).to.equal("Process /bin/sh failed.");
        expect(error.cause).to.be.undefined;
        expect(error.payload).to.deep.equal({ file: "/bin/sh", args: ["-c", "exit 3"], cause: "SIGKILL" });
    });
});
